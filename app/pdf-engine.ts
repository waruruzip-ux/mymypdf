import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_PAGES = 500;

export interface SourceFile {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  bytes: ArrayBuffer;
}

export interface ProcessingState {
  kind: 'idle' | 'loading' | 'merging' | 'splitting' | 'extracting' | 'deleting';
  progress: number;
  message: string;
}

export interface PageThumbnail {
  pageIndex: number;
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  dataUrl: string;
}

interface PageReference {
  sourceId: string;
  sourceName: string;
  sourcePageIndex: number;
}

type ProgressHandler = (progress: number, message: string) => void;

let pdfJsModule: typeof import('pdfjs-dist') | null = null;

async function getPdfJs() {
  if (!pdfJsModule) {
    pdfJsModule = await import('pdfjs-dist');
    pdfJsModule.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }
  return pdfJsModule;
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanBaseName(name: string) {
  const withoutExtension = name.replace(/\.pdf$/i, '');
  return withoutExtension.replace(/[\\/:*?"<>|]/g, '-').trim() || 'document';
}

function friendlyPdfError(error: unknown, fileName: string) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/encrypt|password/i.test(message)) {
    return `${fileName}: 암호로 보호된 PDF는 현재 편집할 수 없습니다.`;
  }
  return `${fileName}: 손상되었거나 지원하지 않는 PDF입니다.`;
}

async function renderThumbnail(pdfPage: unknown) {
  const page = pdfPage as {
    getViewport: (options: { scale: number }) => { width: number; height: number; rotation: number };
    render: (options: {
      canvas: HTMLCanvasElement;
      canvasContext: CanvasRenderingContext2D;
      viewport: unknown;
      background: string;
    }) => { promise: Promise<void> };
  };
  const baseViewport = page.getViewport({ scale: 1 });
  const cssWidth = 220;
  const scale = Math.min(1.4, cssWidth / Math.max(1, baseViewport.width));
  const viewport = page.getViewport({ scale });
  const density = Math.min(1.7, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * density));
  canvas.height = Math.max(1, Math.floor(viewport.height * density));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is unavailable');
  context.setTransform(density, 0, 0, density, 0, 0);
  await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.8),
    width: Math.round(baseViewport.width),
    height: Math.round(baseViewport.height),
    rotation: baseViewport.rotation,
  };
}

export async function renderPdfThumbnails(source: SourceFile, onProgress: ProgressHandler) {
  const pdfjs = await getPdfJs();
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(source.bytes.slice(0)),
    });
    pdf = await task.promise;
  } catch (error) {
    throw new Error(friendlyPdfError(error, source.name));
  }

  const thumbnails: PageThumbnail[] = [];
  try {
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      const pdfPage = await pdf.getPage(pageIndex + 1);
      const thumbnail = await renderThumbnail(pdfPage);
      thumbnails.push({
        pageIndex,
        pageNumber: pageIndex + 1,
        width: thumbnail.width,
        height: thumbnail.height,
        rotation: thumbnail.rotation,
        dataUrl: thumbnail.dataUrl,
      });
      pdfPage.cleanup();
      onProgress(
        Math.round(((pageIndex + 1) / pdf.numPages) * 100),
        `${source.name} ${pageIndex + 1}/${pdf.numPages} 페이지 준비 중`,
      );
    }
  } finally {
    const disposablePdf = pdf as unknown as {
      destroy?: () => Promise<void>;
      cleanup?: () => Promise<void> | void;
    };
    if (typeof disposablePdf.destroy === 'function') await disposablePdf.destroy();
    else if (typeof disposablePdf.cleanup === 'function') await disposablePdf.cleanup();
  }
  return thumbnails;
}

export async function inspectPdfFile(
  file: File,
  onProgress: ProgressHandler,
  remainingPageLimit = MAX_TOTAL_PAGES,
) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    throw new Error(`${file.name}: PDF 파일만 추가할 수 있습니다.`);
  }

  onProgress(10, `${file.name} 파일을 읽는 중`);
  const bytes = await file.arrayBuffer();
  try {
    const sourceDocument = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    const pageCount = sourceDocument.getPageCount();
    if (pageCount < 1) throw new Error('Empty PDF');
    if (pageCount > remainingPageLimit) {
      throw new Error(`전체 페이지가 ${MAX_TOTAL_PAGES}페이지를 넘을 수 없습니다.`);
    }
    onProgress(100, `${file.name} ${pageCount}페이지 확인 완료`);
    return {
      id: createId('source'),
      name: file.name,
      size: file.size,
      pageCount,
      bytes,
    } satisfies SourceFile;
  } catch (error) {
    if (error instanceof Error && error.message.includes('전체 페이지')) throw error;
    throw new Error(friendlyPdfError(error, file.name));
  }
}

async function buildPdf(
  references: PageReference[],
  sources: SourceFile[],
  title: string,
  onProgress: ProgressHandler,
) {
  if (!references.length) throw new Error('저장할 페이지가 없습니다.');
  const output = await PDFDocument.create();
  output.setTitle(title);
  output.setCreator('마이PDF');
  output.setProducer('마이PDF');
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const loaded = new Map<string, PDFDocument>();

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const source = sourceMap.get(reference.sourceId);
    if (!source) throw new Error(`${reference.sourceName} 원본을 찾을 수 없습니다.`);
    let sourceDocument = loaded.get(source.id);
    if (!sourceDocument) {
      sourceDocument = await PDFDocument.load(source.bytes.slice(0), { updateMetadata: false });
      loaded.set(source.id, sourceDocument);
    }
    const [copiedPage] = await output.copyPages(sourceDocument, [reference.sourcePageIndex]);
    output.addPage(copiedPage);
    onProgress(
      Math.round(((index + 1) / references.length) * 92),
      `${index + 1}/${references.length} 페이지 처리 중`,
    );
  }

  onProgress(96, '다운로드 파일을 마무리하는 중');
  return output.save({ useObjectStreams: true });
}

function referencesFor(source: SourceFile, pageIndexes: number[]): PageReference[] {
  return pageIndexes.map((sourcePageIndex) => ({
    sourceId: source.id,
    sourceName: source.name,
    sourcePageIndex,
  }));
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function pdfBlob(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes);
  return new Blob([copy.buffer], { type: 'application/pdf' });
}

export async function downloadMergedPdf(sources: SourceFile[], onProgress: ProgressHandler) {
  if (!sources.length) throw new Error('병합할 PDF가 없습니다.');
  const references = sources.flatMap((source) =>
    referencesFor(source, Array.from({ length: source.pageCount }, (_, index) => index)),
  );
  const bytes = await buildPdf(references, sources, '마이PDF 병합 문서', onProgress);
  downloadBlob(pdfBlob(bytes), 'merged.pdf');
}

export async function downloadExtractedPdf(
  source: SourceFile,
  pageIndexes: number[],
  onProgress: ProgressHandler,
) {
  const bytes = await buildPdf(
    referencesFor(source, pageIndexes),
    [source],
    '마이PDF 추출 페이지',
    onProgress,
  );
  downloadBlob(pdfBlob(bytes), 'extracted-pages.pdf');
}

export async function downloadDeletedPdf(
  source: SourceFile,
  deletedPageIndexes: number[],
  onProgress: ProgressHandler,
) {
  const deleted = new Set(deletedPageIndexes);
  const retained = Array.from({ length: source.pageCount }, (_, index) => index).filter(
    (pageIndex) => !deleted.has(pageIndex),
  );
  if (!retained.length) throw new Error('모든 페이지를 삭제할 수는 없습니다. 한 페이지 이상 남겨 주세요.');
  const bytes = await buildPdf(
    referencesFor(source, retained),
    [source],
    '마이PDF 페이지 삭제 문서',
    onProgress,
  );
  downloadBlob(pdfBlob(bytes), `${cleanBaseName(source.name)}-pages-deleted.pdf`);
}

export async function downloadSplitZip(
  source: SourceFile,
  pageIndexes: number[],
  onProgress: ProgressHandler,
) {
  if (!pageIndexes.length) throw new Error('분할할 페이지를 선택해 주세요.');
  const zip = new JSZip();
  for (let index = 0; index < pageIndexes.length; index += 1) {
    const pageIndex = pageIndexes[index];
    const bytes = await buildPdf(
      referencesFor(source, [pageIndex]),
      [source],
      `${source.name} ${pageIndex + 1}페이지`,
      () => undefined,
    );
    const order = String(index + 1).padStart(3, '0');
    const original = String(pageIndex + 1).padStart(3, '0');
    zip.file(`${order}-${cleanBaseName(source.name)}-p${original}.pdf`, bytes);
    onProgress(
      Math.round(((index + 1) / pageIndexes.length) * 82),
      `${index + 1}/${pageIndexes.length}개 PDF 만드는 중`,
    );
  }
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => onProgress(82 + Math.round(metadata.percent * 0.17), 'ZIP 파일을 만드는 중'),
  );
  downloadBlob(blob, 'mypdf-split.zip');
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

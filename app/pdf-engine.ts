import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

// Vite turns this worker module into a versioned static asset URL.
// @ts-expect-error Vite asset query modules do not ship TypeScript declarations.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_PAGES = 500;

export interface SourceFile {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  bytes: ArrayBuffer;
}

export interface EditorPage {
  id: string;
  sourceId: string;
  sourceName: string;
  sourcePageIndex: number;
  originalPageNumber: number;
  width: number;
  height: number;
  rotation: number;
  thumbnail: string;
}

export type PageSelection = Set<string>;

export interface ProcessingState {
  kind: 'idle' | 'loading' | 'merging' | 'splitting' | 'extracting';
  progress: number;
  message: string;
}

type ProgressHandler = (progress: number, message: string) => void;

let pdfJsModule: typeof import('pdfjs-dist') | null = null;

async function getPdfJs() {
  if (!pdfJsModule) {
    pdfJsModule = await import('pdfjs-dist');
    pdfJsModule.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
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
    render: (options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown; background: string }) => { promise: Promise<void> };
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

export async function inspectPdfFile(file: File, onProgress: ProgressHandler, remainingPageLimit = MAX_TOTAL_PAGES) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    throw new Error(`${file.name}: PDF 파일만 추가할 수 있습니다.`);
  }

  const bytes = await file.arrayBuffer();
  let expectedPageCount = 0;
  try {
    const sourceDocument = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    expectedPageCount = sourceDocument.getPageCount();
    if (expectedPageCount < 1) throw new Error('Empty PDF');
  } catch (error) {
    throw new Error(friendlyPdfError(error, file.name));
  }
  if (expectedPageCount > remainingPageLimit) {
    throw new Error(`전체 페이지가 ${MAX_TOTAL_PAGES}페이지를 넘을 수 없습니다.`);
  }

  const pdfjs = await getPdfJs();
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false });
    pdf = await task.promise;
  } catch (error) {
    throw new Error(friendlyPdfError(error, file.name));
  }

  const sourceId = createId('source');
  const pages: EditorPage[] = [];
  try {
    for (let index = 0; index < pdf.numPages; index += 1) {
      const pdfPage = await pdf.getPage(index + 1);
      const thumbnail = await renderThumbnail(pdfPage);
      pages.push({
        id: createId('page'),
        sourceId,
        sourceName: file.name,
        sourcePageIndex: index,
        originalPageNumber: index + 1,
        width: thumbnail.width,
        height: thumbnail.height,
        rotation: thumbnail.rotation,
        thumbnail: thumbnail.dataUrl,
      });
      pdfPage.cleanup();
      onProgress(Math.round(((index + 1) / pdf.numPages) * 100), `${file.name} ${index + 1}/${pdf.numPages} 페이지 준비 중`);
    }
  } finally {
    const disposablePdf = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> | void };
    if (typeof disposablePdf.destroy === 'function') await disposablePdf.destroy();
    else if (typeof disposablePdf.cleanup === 'function') await disposablePdf.cleanup();
  }

  const source: SourceFile = {
    id: sourceId,
    name: file.name,
    size: file.size,
    pageCount: pages.length,
    bytes,
  };
  return { source, pages };
}

async function buildPdf(
  pages: EditorPage[],
  sources: SourceFile[],
  title: string,
  onProgress: ProgressHandler,
) {
  const output = await PDFDocument.create();
  output.setTitle(title);
  output.setCreator('마이PDF');
  output.setProducer('마이PDF');
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const loaded = new Map<string, PDFDocument>();

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const source = sourceMap.get(page.sourceId);
    if (!source) throw new Error(`${page.sourceName} 원본을 찾을 수 없습니다.`);
    let sourceDocument = loaded.get(source.id);
    if (!sourceDocument) {
      sourceDocument = await PDFDocument.load(source.bytes.slice(0), { updateMetadata: false });
      loaded.set(source.id, sourceDocument);
    }
    const [copiedPage] = await output.copyPages(sourceDocument, [page.sourcePageIndex]);
    output.addPage(copiedPage);
    onProgress(Math.round(((index + 1) / pages.length) * 92), `${index + 1}/${pages.length} 페이지 처리 중`);
  }

  onProgress(96, '다운로드 파일을 마무리하는 중');
  return output.save({ useObjectStreams: true });
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

export async function downloadCombinedPdf(
  pages: EditorPage[],
  sources: SourceFile[],
  fileName: string,
  title: string,
  onProgress: ProgressHandler,
) {
  if (!pages.length) throw new Error('저장할 페이지가 없습니다.');
  const bytes = await buildPdf(pages, sources, title, onProgress);
  downloadBlob(pdfBlob(bytes), fileName);
}

export async function downloadSplitZip(
  pages: EditorPage[],
  sources: SourceFile[],
  onProgress: ProgressHandler,
) {
  if (!pages.length) throw new Error('분할할 페이지가 없습니다.');
  const zip = new JSZip();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const bytes = await buildPdf([page], sources, `${page.sourceName} ${page.originalPageNumber}페이지`, () => undefined);
    const order = String(index + 1).padStart(3, '0');
    const original = String(page.originalPageNumber).padStart(3, '0');
    zip.file(`${order}-${cleanBaseName(page.sourceName)}-p${original}.pdf`, bytes);
    onProgress(Math.round(((index + 1) / pages.length) * 82), `${index + 1}/${pages.length} 페이지 분할 중`);
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

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

export interface SplitRange {
  label: string;
  pageIndexes: number[];
}

interface PageReference {
  sourceId: string;
  sourceName: string;
  sourcePageIndex: number;
}

type ProgressHandler = (progress: number, message: string) => void;

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

function parseToken(token: string, pageCount: number) {
  const normalized = token.trim();
  const match = normalized.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) {
    throw new Error(`“${normalized || token}” 형식을 확인해 주세요. 예: 1, 3, 5-7`);
  }

  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
    throw new Error(`페이지는 1부터 ${pageCount}까지 입력할 수 있습니다.`);
  }
  if (start > end) {
    throw new Error(`“${normalized}” 범위는 작은 페이지부터 입력해 주세요.`);
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index - 1);
}

function getTokens(expression: string) {
  const value = expression.trim();
  if (!value) throw new Error('페이지 번호나 범위를 입력해 주세요.');
  const tokens = value.split(',');
  if (tokens.some((token) => !token.trim())) {
    throw new Error('쉼표 사이에 페이지 번호나 범위를 입력해 주세요.');
  }
  return tokens;
}

export function parsePageExpression(expression: string, pageCount: number) {
  const seen = new Set<number>();
  const pageIndexes: number[] = [];
  for (const token of getTokens(expression)) {
    for (const pageIndex of parseToken(token, pageCount)) {
      if (!seen.has(pageIndex)) {
        seen.add(pageIndex);
        pageIndexes.push(pageIndex);
      }
    }
  }
  return pageIndexes;
}

export function parseSplitRanges(expression: string, pageCount: number) {
  const seen = new Set<number>();
  return getTokens(expression).map((token) => {
    const pageIndexes = parseToken(token, pageCount);
    for (const pageIndex of pageIndexes) {
      if (seen.has(pageIndex)) {
        throw new Error(`${pageIndex + 1}페이지가 두 범위에 겹쳐 있습니다.`);
      }
      seen.add(pageIndex);
    }
    return {
      label: token.trim().replace(/\s+/g, ''),
      pageIndexes,
    } satisfies SplitRange;
  });
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
  ranges: SplitRange[],
  onProgress: ProgressHandler,
) {
  if (!ranges.length) throw new Error('분할할 페이지 범위를 입력해 주세요.');
  const zip = new JSZip();
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const bytes = await buildPdf(
      referencesFor(source, range.pageIndexes),
      [source],
      `${source.name} ${range.label}페이지`,
      () => undefined,
    );
    const order = String(index + 1).padStart(2, '0');
    zip.file(`${order}-${cleanBaseName(source.name)}-p${range.label}.pdf`, bytes);
    onProgress(
      Math.round(((index + 1) / ranges.length) * 82),
      `${index + 1}/${ranges.length}개 PDF 만드는 중`,
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

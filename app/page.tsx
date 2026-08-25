'use client';

import { ChangeEvent, DragEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import {
  downloadDeletedPdf,
  downloadExtractedPdf,
  downloadMergedPdf,
  downloadSplitZip,
  formatBytes,
  inspectPdfFile,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_PAGES,
  PageRange,
  PageThumbnail,
  ProcessingState,
  renderPdfThumbnails,
  SourceFile,
} from './pdf-engine';

type Notice = { tone: 'success' | 'error'; text: string } | null;
type EditorMode = 'merge' | 'split' | 'extract' | 'delete';

const iconGlyphs = {
  check: '✓',
  download: '↓',
  extract: '↗',
  file: '▤',
  files: '▥',
  grip: '⋮⋮',
  loading: '◌',
  plus: '+',
  reset: '↻',
  scissors: '✂',
  shield: '●',
  split: '▦',
  trash: '−',
  up: '↑',
  down: '↓',
  upload: '↑',
  x: '×',
} as const;

const modeDetails: Record<EditorMode, {
  label: string;
  icon: keyof typeof iconGlyphs;
  title: string;
  description: string;
  button: string;
}> = {
  merge: {
    label: '병합',
    icon: 'files',
    title: '파일 순서를 정리하세요',
    description: '위에서부터 차례대로 하나의 PDF로 합쳐집니다. 파일 카드를 끌어서 순서를 바꿀 수 있어요.',
    button: '이 순서대로 병합',
  },
  split: {
    label: '분할',
    icon: 'split',
    title: '나눌 구간을 드래그하세요',
    description: '시작 페이지에서 끝 페이지까지 드래그하면 그 범위가 하나의 PDF가 됩니다.',
    button: '구간 PDF ZIP 받기',
  },
  extract: {
    label: '추출',
    icon: 'scissors',
    title: '필요한 페이지를 골라주세요',
    description: '선택한 페이지를 화면 순서대로 모아 하나의 새 PDF를 만듭니다.',
    button: '선택 페이지 추출',
  },
  delete: {
    label: '삭제',
    icon: 'trash',
    title: '빼고 싶은 페이지를 골라주세요',
    description: '원본은 건드리지 않고, 선택한 페이지를 제외한 새 PDF를 만듭니다.',
    button: '선택 페이지 삭제',
  },
};

function UiIcon({ name, className = '' }: { name: keyof typeof iconGlyphs; className?: string }) {
  return <span className={`ui-icon ${className}`} aria-hidden="true">{iconGlyphs[name]}</span>;
}

const idleProcessing: ProcessingState = { kind: 'idle', progress: 0, message: '' };

type DragSelectionSession = {
  pointerId: number;
  pointerType: string;
  startDisplayIndex: number;
  currentDisplayIndex: number;
  startX: number;
  startY: number;
  lastY: number;
  active: boolean;
  moved: boolean;
  scrolling: boolean;
  selecting: boolean;
  captureTarget: HTMLElement;
};

function normalizeRange(startIndex: number, endIndex: number): PageRange {
  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  };
}

function rangeContains(range: PageRange | null, pageIndex: number) {
  return Boolean(range && pageIndex >= range.startIndex && pageIndex <= range.endIndex);
}

function rangePageCount(range: PageRange) {
  return range.endIndex - range.startIndex + 1;
}

function rangesOverlap(first: PageRange, second: PageRange) {
  return first.startIndex <= second.endIndex && second.startIndex <= first.endIndex;
}

function fileListSize(sources: SourceFile[]) {
  return sources.reduce((total, source) => total + source.size, 0);
}

function totalPageCount(sources: SourceFile[]) {
  return sources.reduce((total, source) => total + source.pageCount, 0);
}

export default function Home() {
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [activeMode, setActiveMode] = useState<EditorMode>('merge');
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [selectedPageIndexes, setSelectedPageIndexes] = useState<Set<number>>(new Set());
  const [splitRanges, setSplitRanges] = useState<PageRange[]>([]);
  const [draftRange, setDraftRange] = useState<PageRange | null>(null);
  const [draftSelecting, setDraftSelecting] = useState(true);
  const [processing, setProcessing] = useState<ProcessingState>(idleProcessing);
  const [notice, setNotice] = useState<Notice>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dragOverSourceId, setDragOverSourceId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorFileInputRef = useRef<HTMLInputElement>(null);
  const draggedSourceIdRef = useRef<string | null>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const dragSelectionRef = useRef<DragSelectionSession | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const dragPointerRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const thumbnailCacheRef = useRef(new Map<string, PageThumbnail[]>());
  const thumbnailPromiseCacheRef = useRef(new Map<string, Promise<PageThumbnail[]>>());

  const busy = processing.kind !== 'idle';
  const hasWorkspace = sources.length > 0;
  const totalBytes = fileListSize(sources);
  const totalPages = totalPageCount(sources);
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? sources[0];
  const details = modeDetails[activeMode];
  const splitPageCount = splitRanges.reduce((total, range) => total + rangePageCount(range), 0);

  async function prepareThumbnails(source: SourceFile) {
    setSelectedPageIndexes(new Set());
    setSplitRanges([]);
    setDraftRange(null);
    lastSelectedIndexRef.current = null;
    const cached = thumbnailCacheRef.current.get(source.id);
    if (cached) {
      setThumbnails(cached);
      return;
    }

    setThumbnails([]);
    setProcessing({ kind: 'loading', progress: 1, message: `${source.name} 페이지를 준비하는 중` });
    let pending = thumbnailPromiseCacheRef.current.get(source.id);
    if (!pending) {
      pending = renderPdfThumbnails(source, (progress, message) => {
        setProcessing({ kind: 'loading', progress, message });
      });
      thumbnailPromiseCacheRef.current.set(source.id, pending);
    }

    try {
      const result = await pending;
      thumbnailCacheRef.current.set(source.id, result);
      setThumbnails(result);
    } catch (error) {
      thumbnailPromiseCacheRef.current.delete(source.id);
      showNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '페이지 미리보기를 만들지 못했습니다.',
      });
    } finally {
      setProcessing(idleProcessing);
    }
  }

  function showNotice(next: Notice) {
    setNotice(next);
    window.setTimeout(() => setNotice((current) => (current === next ? null : current)), 4_000);
  }

  async function addFiles(fileList: FileList | File[]) {
    if (busy) return;
    const files = Array.from(fileList);
    if (!files.length) return;

    const incomingBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes + incomingBytes > MAX_TOTAL_BYTES) {
      showNotice({ tone: 'error', text: '전체 파일 크기는 100MB를 넘을 수 없습니다.' });
      return;
    }

    setNotice(null);
    setProcessing({ kind: 'loading', progress: 1, message: 'PDF 파일을 확인하는 중' });
    const pendingSources: SourceFile[] = [];

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const pendingPages = totalPageCount(pendingSources);
        const source = await inspectPdfFile(
          file,
          (fileProgress, message) => {
            const overall = Math.round(((fileIndex + fileProgress / 100) / files.length) * 100);
            setProcessing({ kind: 'loading', progress: overall, message });
          },
          MAX_TOTAL_PAGES - totalPages - pendingPages,
        );
        pendingSources.push(source);
      }
      setSources((current) => [...current, ...pendingSources]);
      setSelectedSourceId((current) => current || pendingSources[0]?.id || '');
      const addedPages = totalPageCount(pendingSources);
      showNotice({
        tone: 'success',
        text: `${pendingSources.length}개 파일, ${addedPages}페이지를 안전하게 불러왔습니다.`,
      });
    } catch (error) {
      showNotice({ tone: 'error', text: error instanceof Error ? error.message : 'PDF를 불러오지 못했습니다.' });
    } finally {
      setProcessing(idleProcessing);
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (selectedFiles.length) void addFiles(selectedFiles);
  }

  function handleFileDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDraggingFiles(false);
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  }

  function switchMode(mode: EditorMode) {
    if (busy) return;
    setActiveMode(mode);
    setSelectedPageIndexes(new Set());
    setSplitRanges([]);
    setDraftRange(null);
    lastSelectedIndexRef.current = null;
    setNotice(null);
    if (mode === 'merge') setThumbnails([]);
    else if (selectedSource) void prepareThumbnails(selectedSource);
  }

  function moveSource(index: number, offset: number) {
    const destination = index + offset;
    if (destination < 0 || destination >= sources.length) return;
    setSources((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  function reorderSource(targetId: string) {
    const draggedId = draggedSourceIdRef.current;
    if (!draggedId || draggedId === targetId) return;
    setSources((current) => {
      const fromIndex = current.findIndex((source) => source.id === draggedId);
      const toIndex = current.findIndex((source) => source.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    draggedSourceIdRef.current = null;
    setDragOverSourceId(null);
  }

  function removeSource(sourceId: string) {
    if (busy) return;
    const next = sources.filter((source) => source.id !== sourceId);
    thumbnailCacheRef.current.delete(sourceId);
    thumbnailPromiseCacheRef.current.delete(sourceId);
    setSources(next);
    if (selectedSource?.id === sourceId) {
      setSelectedPageIndexes(new Set());
      setSplitRanges([]);
      setDraftRange(null);
      setThumbnails([]);
      setSelectedSourceId(next[0]?.id ?? '');
      if (activeMode !== 'merge' && next[0]) void prepareThumbnails(next[0]);
    }
    showNotice({ tone: 'success', text: '작업 목록에서 파일을 뺐습니다. 원본 파일은 그대로예요.' });
  }

  function resetWorkspace() {
    if (busy) return;
    setSources([]);
    setActiveMode('merge');
    setSelectedSourceId('');
    setThumbnails([]);
    setSelectedPageIndexes(new Set());
    setSplitRanges([]);
    setDraftRange(null);
    thumbnailCacheRef.current.clear();
    thumbnailPromiseCacheRef.current.clear();
    lastSelectedIndexRef.current = null;
    setNotice(null);
  }

  function togglePage(displayIndex: number, shiftKey: boolean) {
    const page = thumbnails[displayIndex];
    if (!page || busy) return;
    setSelectedPageIndexes((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(displayIndex, lastSelectedIndexRef.current);
        const end = Math.max(displayIndex, lastSelectedIndexRef.current);
        const shouldSelect = !current.has(page.pageIndex);
        for (let index = start; index <= end; index += 1) {
          if (shouldSelect) next.add(thumbnails[index].pageIndex);
          else next.delete(thumbnails[index].pageIndex);
        }
      } else if (next.has(page.pageIndex)) next.delete(page.pageIndex);
      else next.add(page.pageIndex);
      return next;
    });
    lastSelectedIndexRef.current = displayIndex;
  }

  function handlePageKeyDown(event: KeyboardEvent<HTMLElement>, displayIndex: number) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePage(displayIndex, event.shiftKey);
    }
  }

  function toggleAllPages() {
    if (busy || !thumbnails.length) return;
    setSelectedPageIndexes((current) =>
      current.size === thumbnails.length
        ? new Set()
        : new Set(thumbnails.map((page) => page.pageIndex)),
    );
    lastSelectedIndexRef.current = null;
  }

  function addSplitRange(range: PageRange) {
    const normalized = normalizeRange(range.startIndex, range.endIndex);
    if (splitRanges.some((current) => rangesOverlap(current, normalized))) {
      showNotice({ tone: 'error', text: '이미 지정한 구간과 겹칩니다. 겹치지 않게 다시 드래그해 주세요.' });
      return;
    }
    setSplitRanges((current) => [...current, normalized].sort((a, b) => a.startIndex - b.startIndex));
    setSelectedPageIndexes(new Set());
    lastSelectedIndexRef.current = null;
  }

  function addSelectedAsSplitRange() {
    const indexes = [...selectedPageIndexes].sort((a, b) => a - b);
    if (!indexes.length) {
      showNotice({ tone: 'error', text: '추가할 시작·끝 페이지를 먼저 선택해 주세요.' });
      return;
    }
    const range = normalizeRange(indexes[0], indexes[indexes.length - 1]);
    if (rangePageCount(range) !== indexes.length) {
      showNotice({ tone: 'error', text: '분할 구간은 중간에 빠진 페이지 없이 연속으로 선택해 주세요.' });
      return;
    }
    addSplitRange(range);
  }

  function applyDraggedPageSelection(range: PageRange, selecting: boolean) {
    setSelectedPageIndexes((current) => {
      const next = new Set(current);
      for (let pageIndex = range.startIndex; pageIndex <= range.endIndex; pageIndex += 1) {
        if (selecting) next.add(pageIndex);
        else next.delete(pageIndex);
      }
      return next;
    });
    lastSelectedIndexRef.current = null;
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function stopAutoScroll() {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }

  function updateDragTargetAtPoint(clientX: number, clientY: number) {
    const session = dragSelectionRef.current;
    if (!session?.active) return;
    const pointed = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-page-display-index]');
    if (!pointed) return;
    const displayIndex = Number(pointed.dataset.pageDisplayIndex);
    if (!Number.isInteger(displayIndex) || !thumbnails[displayIndex] || displayIndex === session.currentDisplayIndex) return;
    session.currentDisplayIndex = displayIndex;
    setDraftRange(normalizeRange(
      thumbnails[session.startDisplayIndex].pageIndex,
      thumbnails[displayIndex].pageIndex,
    ));
  }

  function startAutoScroll() {
    if (autoScrollFrameRef.current !== null) return;
    const step = () => {
      const session = dragSelectionRef.current;
      if (!session?.active) {
        autoScrollFrameRef.current = null;
        return;
      }
      const { x, y } = dragPointerRef.current;
      const topEdge = 110;
      const bottomEdge = window.innerHeight - 120;
      let velocity = 0;
      if (y < topEdge) velocity = -Math.min(18, Math.max(4, (topEdge - y) / 4));
      else if (y > bottomEdge) velocity = Math.min(18, Math.max(4, (y - bottomEdge) / 4));
      if (velocity) {
        window.scrollBy(0, velocity);
        updateDragTargetAtPoint(x, Math.min(bottomEdge, Math.max(topEdge, y)));
      }
      autoScrollFrameRef.current = window.requestAnimationFrame(step);
    };
    autoScrollFrameRef.current = window.requestAnimationFrame(step);
  }

  function handlePagePointerDown(event: ReactPointerEvent<HTMLElement>, displayIndex: number) {
    if (busy || event.button !== 0 || !thumbnails[displayIndex]) return;
    const pageIndex = thumbnails[displayIndex].pageIndex;
    const isTouch = event.pointerType === 'touch';
    const session: DragSelectionSession = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startDisplayIndex: displayIndex,
      currentDisplayIndex: displayIndex,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      active: !isTouch,
      moved: false,
      scrolling: false,
      selecting: activeMode === 'split' || !selectedPageIndexes.has(pageIndex),
      captureTarget: event.currentTarget,
    };
    dragSelectionRef.current = session;
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (session.active) {
      setDraftSelecting(session.selecting);
      setDraftRange({ startIndex: pageIndex, endIndex: pageIndex });
      return;
    }
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      const current = dragSelectionRef.current;
      if (!current || current.pointerId !== event.pointerId || current.scrolling) return;
      current.active = true;
      setDraftSelecting(current.selecting);
      setDraftRange({ startIndex: pageIndex, endIndex: pageIndex });
      startAutoScroll();
    }, 320);
  }

  function handlePagePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = dragSelectionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (session.pointerType === 'touch' && !session.active) {
      if (distance > 7) {
        session.scrolling = true;
        clearLongPressTimer();
        window.scrollBy(0, session.lastY - event.clientY);
        session.lastY = event.clientY;
        suppressClickRef.current = true;
        event.preventDefault();
      }
      return;
    }
    if (!session.active) return;
    if (distance > 4) session.moved = true;
    if (!session.moved) return;
    event.preventDefault();
    updateDragTargetAtPoint(event.clientX, event.clientY);
    startAutoScroll();
  }

  function finishPagePointer(pointerId: number, cancelled = false) {
    const session = dragSelectionRef.current;
    if (!session || session.pointerId !== pointerId) return;
    clearLongPressTimer();
    stopAutoScroll();
    const shouldCommit = !cancelled && session.active && session.moved;
    const range = normalizeRange(
      thumbnails[session.startDisplayIndex]?.pageIndex ?? 0,
      thumbnails[session.currentDisplayIndex]?.pageIndex ?? 0,
    );
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }
    dragSelectionRef.current = null;
    setDraftRange(null);
    if (shouldCommit) {
      if (activeMode === 'split') addSplitRange(range);
      else applyDraggedPageSelection(range, session.selecting);
      suppressClickRef.current = true;
    }
    if (session.scrolling || shouldCommit) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => finishPagePointer(event.pointerId);
    const handlePointerCancel = (event: PointerEvent) => finishPagePointer(event.pointerId, true);
    const handleMouseUp = () => {
      const pointerId = dragSelectionRef.current?.pointerId;
      if (pointerId !== undefined) finishPagePointer(pointerId);
    };
    const handleWindowBlur = () => {
      const pointerId = dragSelectionRef.current?.pointerId;
      if (pointerId !== undefined) finishPagePointer(pointerId, true);
    };
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  });

  async function runAction() {
    if (busy) return;
    if (!sources.length) {
      showNotice({ tone: 'error', text: '처리할 PDF를 먼저 추가해 주세요.' });
      return;
    }

    const pageIndexes = [...selectedPageIndexes].sort((a, b) => a - b);
    if (activeMode === 'split' && !splitRanges.length) {
      showNotice({ tone: 'error', text: '분할할 구간을 먼저 드래그해 주세요.' });
      return;
    }
    if ((activeMode === 'extract' || activeMode === 'delete') && !pageIndexes.length) {
      showNotice({ tone: 'error', text: `${details.label}할 페이지를 먼저 선택해 주세요.` });
      return;
    }

    const processingKind: ProcessingState['kind'] =
      activeMode === 'merge' ? 'merging' :
      activeMode === 'split' ? 'splitting' :
      activeMode === 'extract' ? 'extracting' : 'deleting';
    const startMessage =
      activeMode === 'merge' ? '파일 순서대로 합치는 중' :
      activeMode === 'split' ? '지정한 구간을 나누는 중' :
      activeMode === 'extract' ? '선택한 페이지를 추출하는 중' : '선택한 페이지를 제외하는 중';

    try {
      if (activeMode !== 'merge' && !selectedSource) throw new Error('작업할 PDF를 선택해 주세요.');
      setProcessing({ kind: processingKind, progress: 2, message: startMessage });
      const updateProgress = (progress: number, message: string) =>
        setProcessing({ kind: processingKind, progress, message });

      if (activeMode === 'merge') await downloadMergedPdf(sources, updateProgress);
      else if (activeMode === 'split') await downloadSplitZip(selectedSource, splitRanges, updateProgress);
      else if (activeMode === 'extract') await downloadExtractedPdf(selectedSource, pageIndexes, updateProgress);
      else await downloadDeletedPdf(selectedSource, pageIndexes, updateProgress);

      const successText =
        activeMode === 'merge' ? '병합 PDF를 다운로드했습니다.' :
        activeMode === 'split' ? '구간별 PDF가 담긴 ZIP을 다운로드했습니다.' :
        activeMode === 'extract' ? '선택한 페이지 PDF를 다운로드했습니다.' : '선택한 페이지를 제외한 새 PDF를 다운로드했습니다.';
      showNotice({ tone: 'success', text: successText });
    } catch (error) {
      showNotice({ tone: 'error', text: error instanceof Error ? error.message : '파일을 만드는 중 문제가 발생했습니다.' });
    } finally {
      setProcessing(idleProcessing);
    }
  }

  const fileDropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (!busy && event.dataTransfer.types.includes('Files')) setIsDraggingFiles(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => event.preventDefault(),
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingFiles(false);
    },
    onDrop: handleFileDrop,
  };

  return (
    <main className={`site-shell ${hasWorkspace ? 'workspace-active' : ''}`}>
      <header className="topbar">
        <button className="brand brand-button" type="button" onClick={resetWorkspace} aria-label="마이PDF 처음으로">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>마이PDF</span>
        </button>
        {hasWorkspace ? (
          <div className="header-stats" aria-label="현재 작업 정보">
            <span><UiIcon name="files" /> {sources.length}개 파일</span>
            <span><UiIcon name="file" /> {totalPages}페이지</span>
            <span>{formatBytes(totalBytes)}</span>
          </div>
        ) : (
          <div className="privacy-pill"><span className="privacy-dot" aria-hidden="true" />파일은 기기 안에서만 처리돼요</div>
        )}
      </header>

      {!hasWorkspace ? (
        <section className="hero" id="top" {...fileDropProps}>
          <div className="hero-glow hero-glow-left" aria-hidden="true" />
          <div className="hero-glow hero-glow-right" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow"><span /> 100% 브라우저 처리</p>
            <h1>PDF 여기서 편집해</h1>
            <p className="hero-description">합치고, 나누고, 필요한 페이지만 골라보세요.<br className="desktop-break" /> 업로드 없이 빠르고 간편하게 처리됩니다.</p>
          </div>

          <section className={`upload-card ${isDraggingFiles ? 'is-dragging' : ''}`} aria-labelledby="upload-title">
            <div className="upload-icon" aria-hidden="true">{busy ? <UiIcon name="loading" className="spin" /> : <UiIcon name="upload" />}</div>
            <h2 id="upload-title">{isDraggingFiles ? '여기에 놓으면 바로 시작해요' : 'PDF 파일 여따 넣어'}</h2>
            <p>{busy ? processing.message : '여러 파일을 한 번에 선택할 수 있어요'}</p>
            {busy ? (
              <div className="inline-progress" aria-label={`진행률 ${processing.progress}%`}><span style={{ width: `${processing.progress}%` }} /></div>
            ) : (
              <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}><UiIcon name="plus" /> PDF 파일 선택</button>
            )}
            <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleFileInput} />
            <div className="upload-meta"><span>PDF 전용</span><span aria-hidden="true">·</span><span>최대 100MB</span><span aria-hidden="true">·</span><span>서버 전송 없음</span></div>
          </section>

          <div className="feature-strip" aria-label="지원 기능">
            <span><UiIcon name="files" /> PDF 병합</span>
            <span><UiIcon name="extract" /> 페이지 추출</span>
            <span><UiIcon name="split" /> 구간 분할</span>
            <span><UiIcon name="trash" /> 페이지 삭제</span>
          </div>
        </section>
      ) : (
        <section className="editor-shell" {...fileDropProps}>
          <div className="editor-heading">
            <div>
              <p className="editor-kicker"><UiIcon name="shield" /> 모든 작업은 이 기기에서만 처리됩니다</p>
              <h1>어떤 작업을 할까요?</h1>
              <p>병합은 파일 순서를 정하고, 분할·추출·삭제는 페이지 범위를 드래그하세요.</p>
            </div>
            <div className="editor-heading-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => editorFileInputRef.current?.click()}><UiIcon name="plus" /> 파일 추가</button>
              <button className="icon-text-button" type="button" disabled={busy} onClick={resetWorkspace}><UiIcon name="reset" /> 처음부터</button>
              <input ref={editorFileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleFileInput} />
            </div>
          </div>

          <nav className="mode-tabs" aria-label="PDF 작업 선택">
            {(Object.keys(modeDetails) as EditorMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={activeMode === mode ? 'active' : ''}
                aria-pressed={activeMode === mode}
                disabled={busy}
                onClick={() => switchMode(mode)}
              >
                <UiIcon name={modeDetails[mode].icon} />
                <span>{modeDetails[mode].label}</span>
              </button>
            ))}
          </nav>

          {busy && (
            <div className="workspace-progress" role="status" aria-live="polite">
              <UiIcon name="loading" className="spin" />
              <span>{processing.message}</span>
              <div><i style={{ width: `${processing.progress}%` }} /></div>
              <b>{processing.progress}%</b>
            </div>
          )}

          <section className="operation-panel" aria-labelledby="operation-title">
            <div className="operation-copy">
              <span className="operation-icon"><UiIcon name={details.icon} /></span>
              <div>
                <p>{details.label} 작업</p>
                <h2 id="operation-title">{details.title}</h2>
                <span>{details.description}</span>
              </div>
            </div>

            {activeMode === 'merge' ? (
              <div className="merge-workspace">
                <ol className="file-order-list" aria-label="병합할 PDF 순서">
                  {sources.map((source, index) => (
                    <li
                      key={source.id}
                      className={`file-row ${dragOverSourceId === source.id ? 'is-drag-over' : ''}`}
                      draggable={!busy}
                      onDragStart={(event) => {
                        draggedSourceIdRef.current = source.id;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', source.id);
                      }}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (draggedSourceIdRef.current) setDragOverSourceId(source.id);
                      }}
                      onDragOver={(event) => {
                        if (draggedSourceIdRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = 'move';
                        }
                      }}
                      onDrop={(event) => {
                        if (draggedSourceIdRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          reorderSource(source.id);
                        }
                      }}
                      onDragEnd={() => {
                        draggedSourceIdRef.current = null;
                        setDragOverSourceId(null);
                      }}
                    >
                      <span className="file-index">{index + 1}</span>
                      <span className="file-document-icon"><UiIcon name="file" /></span>
                      <span className="file-meta">
                        <strong title={source.name}>{source.name}</strong>
                        <small>{source.pageCount}페이지 · {formatBytes(source.size)}</small>
                      </span>
                      <UiIcon name="grip" className="file-drag-handle" />
                      <span className="file-order-controls" aria-label={`${source.name} 순서 변경`}>
                        <button type="button" disabled={busy || index === 0} aria-label="한 칸 위로" onClick={() => moveSource(index, -1)}><UiIcon name="up" /></button>
                        <button type="button" disabled={busy || index === sources.length - 1} aria-label="한 칸 아래로" onClick={() => moveSource(index, 1)}><UiIcon name="down" /></button>
                        <button className="remove-file" type="button" disabled={busy} aria-label={`${source.name} 빼기`} onClick={() => removeSource(source.id)}><UiIcon name="x" /></button>
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="operation-footer">
                  <p><strong>{sources.length}개 파일</strong> · 총 {totalPages}페이지</p>
                  <button className="download-button" type="button" disabled={busy || !sources.length} onClick={() => void runAction()}><UiIcon name="download" /> {details.button}</button>
                </div>
              </div>
            ) : (
              <div className="page-workspace">
                <div className="page-toolbar">
                  <label className="document-picker">
                    <span>작업할 PDF</span>
                    <span className="select-wrap">
                      <select
                        value={selectedSource?.id ?? ''}
                        onChange={(event) => {
                          const nextSource = sources.find((source) => source.id === event.target.value);
                          if (!nextSource) return;
                          setSelectedSourceId(nextSource.id);
                          void prepareThumbnails(nextSource);
                        }}
                        disabled={busy}
                      >
                        {sources.map((source) => <option key={source.id} value={source.id}>{source.name} ({source.pageCount}페이지)</option>)}
                      </select>
                    </span>
                  </label>
                  <div className="selection-actions">
                    <strong>
                      {activeMode === 'split'
                        ? (splitRanges.length ? `${splitRanges.length}개 구간 · ${splitPageCount}페이지` : `전체 ${selectedSource?.pageCount ?? 0}페이지`)
                        : (selectedPageIndexes.size ? `${selectedPageIndexes.size}페이지 선택됨` : `전체 ${selectedSource?.pageCount ?? 0}페이지`)}
                    </strong>
                    <button type="button" disabled={busy || !thumbnails.length} onClick={toggleAllPages}>
                      {selectedPageIndexes.size === thumbnails.length && thumbnails.length ? '선택 해제' : '전체 선택'}
                    </button>
                  </div>
                </div>

                {activeMode === 'split' && (
                  <section className="split-range-panel" aria-label="분할 구간 목록">
                    <div className="split-range-heading">
                      <div>
                        <strong>분할 구간</strong>
                        <span>누른 채 끝 페이지까지 드래그하면 구간이 바로 추가돼요.</span>
                      </div>
                      <div className="split-range-actions">
                        <button type="button" disabled={busy || !selectedPageIndexes.size} onClick={addSelectedAsSplitRange}>선택을 구간으로 추가</button>
                        <button type="button" disabled={busy || !splitRanges.length} onClick={() => setSplitRanges([])}>구간 전체 지우기</button>
                      </div>
                    </div>
                    {splitRanges.length ? (
                      <ol className="split-range-list">
                        {splitRanges.map((range, rangeIndex) => (
                          <li key={`${range.startIndex}-${range.endIndex}`}>
                            <span><b>구간 {rangeIndex + 1}</b> · {range.startIndex + 1}–{range.endIndex + 1}쪽</span>
                            <small>{rangePageCount(range)}페이지</small>
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`구간 ${rangeIndex + 1}, ${range.startIndex + 1}쪽부터 ${range.endIndex + 1}쪽까지 삭제`}
                              onClick={() => setSplitRanges((current) => current.filter((item) => item !== range))}
                            >
                              <UiIcon name="x" />
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="split-range-empty">아직 지정한 구간이 없어요. 예: 12쪽에서 22쪽까지 드래그</p>
                    )}
                  </section>
                )}

                {thumbnails.length ? (
                  <div className={`page-grid ${draftRange ? 'is-dragging-range' : ''}`} aria-label={`${selectedSource?.name} 페이지 목록`}>
                    {thumbnails.map((page, displayIndex) => {
                      const splitRangeIndex = activeMode === 'split'
                        ? splitRanges.findIndex((range) => rangeContains(range, page.pageIndex))
                        : -1;
                      const inDraftRange = rangeContains(draftRange, page.pageIndex);
                      const manuallySelected = selectedPageIndexes.has(page.pageIndex);
                      const selected = activeMode === 'split'
                        ? splitRangeIndex >= 0 || manuallySelected || inDraftRange
                        : (inDraftRange ? draftSelecting : manuallySelected);
                      return (
                        <article
                          key={page.pageIndex}
                          data-page-display-index={displayIndex}
                          className={`page-card ${selected ? 'is-selected' : ''} ${inDraftRange ? 'is-draft-range' : ''} ${inDraftRange && !draftSelecting ? 'is-deselect-range' : ''}`}
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`${page.pageNumber}페이지${splitRangeIndex >= 0 ? `, 분할 구간 ${splitRangeIndex + 1}` : selected ? ', 선택됨' : ''}`}
                          tabIndex={0}
                          onPointerDown={(event) => handlePagePointerDown(event, displayIndex)}
                          onPointerMove={handlePagePointerMove}
                          onPointerUp={(event) => finishPagePointer(event.pointerId)}
                          onPointerCancel={(event) => finishPagePointer(event.pointerId, true)}
                          onLostPointerCapture={(event) => finishPagePointer(event.pointerId, true)}
                          onClick={(event) => {
                            if (suppressClickRef.current) return;
                            togglePage(displayIndex, event.shiftKey);
                          }}
                          onKeyDown={(event) => handlePageKeyDown(event, displayIndex)}
                        >
                          <div className="page-card-top">
                            <span className="page-number">{page.pageNumber}페이지</span>
                            {splitRangeIndex >= 0 ? (
                              <span className="range-number-badge" aria-hidden="true">구간 {splitRangeIndex + 1}</span>
                            ) : (
                              <span className="selection-check" aria-hidden="true">{selected ? <UiIcon name="check" /> : null}</span>
                            )}
                          </div>
                          <div className="page-preview" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={page.dataUrl} alt="" draggable={false} />
                          </div>
                          <div className="page-card-footer">
                            <span>{selectedSource?.name}</span>
                            <small>{page.rotation ? `${page.rotation}° 회전` : '원본 방향'}</small>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="page-loading-state" aria-live="polite">
                    <UiIcon name="loading" className={busy ? 'spin' : ''} />
                    <p>{busy ? '페이지 미리보기를 준비하고 있어요.' : '페이지를 불러오지 못했습니다.'}</p>
                  </div>
                )}

                <div className="operation-footer page-operation-footer">
                  {activeMode === 'split' ? (
                    <p><strong>{splitRanges.length}개 구간 · {splitPageCount}페이지</strong> · 데스크톱은 드래그, 모바일은 길게 누른 뒤 드래그하세요</p>
                  ) : (
                    <p><strong>{selectedPageIndexes.size}페이지 선택</strong> · 드래그하면 연속 페이지를 한 번에 선택할 수 있어요</p>
                  )}
                  <button
                    className={`download-button ${activeMode === 'delete' ? 'danger-download' : ''}`}
                    type="button"
                    disabled={busy || (activeMode === 'split' ? !splitRanges.length : !selectedPageIndexes.size)}
                    onClick={() => void runAction()}
                  >
                    <UiIcon name={activeMode === 'delete' ? 'trash' : 'download'} /> {details.button}
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className={`drop-overlay ${isDraggingFiles ? 'visible' : ''}`} aria-hidden="true"><UiIcon name="upload" /><strong>PDF를 놓아 추가하세요</strong></div>
        </section>
      )}

      {!hasWorkspace && <footer><p><strong>마이PDF</strong>는 파일을 서버에 저장하거나 전송하지 않습니다.</p><p>© 2026 마이PDF</p></footer>}

      {notice && (
        <div className={`notice ${notice.tone}`} role="status" aria-live="polite">
          <span>{notice.tone === 'success' ? <UiIcon name="check" /> : <UiIcon name="x" />}</span>
          <p>{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기"><UiIcon name="x" /></button>
        </div>
      )}
    </main>
  );
}

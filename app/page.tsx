'use client';

import { ChangeEvent, DragEvent, KeyboardEvent, useMemo, useRef, useState } from 'react';
import {
  downloadCombinedPdf,
  downloadSplitZip,
  EditorPage,
  formatBytes,
  inspectPdfFile,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_PAGES,
  PageSelection,
  ProcessingState,
  SourceFile,
} from './pdf-engine';

type Notice = { tone: 'success' | 'error'; text: string } | null;

const iconGlyphs = {
  check: '✓',
  download: '↓',
  extract: '↗',
  file: '▤',
  files: '▥',
  grip: '⋮⋮',
  left: '‹',
  loading: '◌',
  plus: '+',
  reset: '↻',
  right: '›',
  scissors: '✂',
  shield: '●',
  split: '▦',
  trash: '−',
  upload: '↑',
  x: '×',
} as const;

function UiIcon({ name, className = '' }: { name: keyof typeof iconGlyphs; className?: string }) {
  return <span className={`ui-icon ${className}`} aria-hidden="true">{iconGlyphs[name]}</span>;
}

const idleProcessing: ProcessingState = { kind: 'idle', progress: 0, message: '' };

function fileListSize(sources: SourceFile[]) {
  return sources.reduce((total, source) => total + source.size, 0);
}

export default function Home() {
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [selection, setSelection] = useState<PageSelection>(new Set());
  const [processing, setProcessing] = useState<ProcessingState>(idleProcessing);
  const [notice, setNotice] = useState<Notice>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dragOverPageId, setDragOverPageId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorFileInputRef = useRef<HTMLInputElement>(null);
  const draggedPageIdRef = useRef<string | null>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

  const busy = processing.kind !== 'idle';
  const hasWorkspace = sources.length > 0;
  const selectedPages = useMemo(() => pages.filter((page) => selection.has(page.id)), [pages, selection]);
  const totalBytes = fileListSize(sources);

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
    const pendingPages: EditorPage[] = [];

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const remainingPages = MAX_TOTAL_PAGES - pages.length - pendingPages.length;
        const result = await inspectPdfFile(
          file,
          (fileProgress, message) => {
            const overall = Math.round(((fileIndex + fileProgress / 100) / files.length) * 100);
            setProcessing({ kind: 'loading', progress: overall, message });
          },
          remainingPages,
        );
        pendingSources.push(result.source);
        pendingPages.push(...result.pages);
      }
      setSources((current) => [...current, ...pendingSources]);
      setPages((current) => [...current, ...pendingPages]);
      showNotice({ tone: 'success', text: `${pendingPages.length}페이지를 안전하게 불러왔습니다.` });
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

  function togglePage(index: number, shiftKey: boolean) {
    const page = pages[index];
    if (!page) return;
    setSelection((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(index, lastSelectedIndexRef.current);
        const end = Math.max(index, lastSelectedIndexRef.current);
        const shouldSelect = !current.has(page.id);
        for (let cursor = start; cursor <= end; cursor += 1) {
          if (shouldSelect) next.add(pages[cursor].id);
          else next.delete(pages[cursor].id);
        }
      } else if (next.has(page.id)) next.delete(page.id);
      else next.add(page.id);
      return next;
    });
    lastSelectedIndexRef.current = index;
  }

  function handlePageKeyDown(event: KeyboardEvent<HTMLElement>, index: number) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePage(index, event.shiftKey);
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      movePage(index, -1);
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      movePage(index, 1);
    }
  }

  function movePage(index: number, offset: number) {
    const destination = index + offset;
    if (destination < 0 || destination >= pages.length) return;
    setPages((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    lastSelectedIndexRef.current = null;
  }

  function reorderPage(targetId: string) {
    const draggedId = draggedPageIdRef.current;
    if (!draggedId || draggedId === targetId) return;
    setPages((current) => {
      const fromIndex = current.findIndex((page) => page.id === draggedId);
      const toIndex = current.findIndex((page) => page.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    lastSelectedIndexRef.current = null;
    draggedPageIdRef.current = null;
    setDragOverPageId(null);
  }

  function deleteSelectedPages() {
    if (!selection.size || busy) return;
    const count = selection.size;
    const remaining = pages.filter((page) => !selection.has(page.id));
    const retainedSources = new Set(remaining.map((page) => page.sourceId));
    setPages(remaining);
    setSources((current) => current.filter((source) => retainedSources.has(source.id)));
    setSelection(new Set());
    lastSelectedIndexRef.current = null;
    showNotice({ tone: 'success', text: `${count}페이지를 작업 화면에서 삭제했습니다. 원본은 그대로예요.` });
  }

  function resetWorkspace() {
    if (busy) return;
    setSources([]);
    setPages([]);
    setSelection(new Set());
    setNotice(null);
    lastSelectedIndexRef.current = null;
  }

  async function runDownload(kind: 'merge' | 'split' | 'extract') {
    if (busy) return;
    const targetPages = kind === 'extract' ? selectedPages : pages;
    if (!targetPages.length) {
      showNotice({ tone: 'error', text: kind === 'extract' ? '추출할 페이지를 먼저 선택해 주세요.' : '처리할 페이지가 없습니다.' });
      return;
    }

    const processingKind = kind === 'merge' ? 'merging' : kind === 'split' ? 'splitting' : 'extracting';
    const startMessage = kind === 'merge' ? 'PDF를 합치는 중' : kind === 'split' ? '페이지를 나누는 중' : '선택 페이지를 추출하는 중';
    setProcessing({ kind: processingKind, progress: 2, message: startMessage });
    try {
      const updateProgress = (progress: number, message: string) => setProcessing({ kind: processingKind, progress, message });
      if (kind === 'split') {
        await downloadSplitZip(targetPages, sources, updateProgress);
      } else {
        await downloadCombinedPdf(
          targetPages,
          sources,
          kind === 'merge' ? 'merged.pdf' : 'extracted-pages.pdf',
          kind === 'merge' ? '마이PDF 병합 문서' : '마이PDF 추출 페이지',
          updateProgress,
        );
      }
      showNotice({ tone: 'success', text: kind === 'merge' ? '병합 PDF를 다운로드했습니다.' : kind === 'split' ? '분할 ZIP을 다운로드했습니다.' : '선택 페이지 PDF를 다운로드했습니다.' });
    } catch (error) {
      showNotice({ tone: 'error', text: error instanceof Error ? error.message : '파일을 만드는 중 문제가 발생했습니다.' });
    } finally {
      setProcessing(idleProcessing);
    }
  }

  const fileDropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => { event.preventDefault(); if (!busy) setIsDraggingFiles(true); },
    onDragOver: (event: DragEvent<HTMLElement>) => event.preventDefault(),
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingFiles(false); },
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
            <span><UiIcon name="file" /> {pages.length}페이지</span>
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
            <h1>내 PDF, 내 기기에서<br />안전하게 편집하세요</h1>
            <p className="hero-description">합치고, 나누고, 필요한 페이지만 골라보세요.<br className="desktop-break" /> 업로드 없이 빠르고 간편하게 처리됩니다.</p>
          </div>

          <section className={`upload-card ${isDraggingFiles ? 'is-dragging' : ''}`} aria-labelledby="upload-title">
            <div className="upload-icon" aria-hidden="true">{busy ? <UiIcon name="loading" className="spin" /> : <UiIcon name="upload" />}</div>
            <h2 id="upload-title">{isDraggingFiles ? '여기에 놓으면 바로 시작해요' : 'PDF 파일을 여기에 놓으세요'}</h2>
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
            <span><UiIcon name="split" /> 페이지별 분할</span>
            <span><UiIcon name="trash" /> 페이지 삭제</span>
          </div>
        </section>
      ) : (
        <section className="editor-shell" {...fileDropProps}>
          <div className="editor-heading">
            <div>
              <p className="editor-kicker"><UiIcon name="shield" /> 모든 작업은 이 기기에서만 처리됩니다</p>
              <h1>페이지를 원하는 순서로 정리하세요</h1>
              <p>페이지를 선택하거나 끌어서 옮긴 뒤, 원하는 작업을 실행하세요.</p>
            </div>
            <div className="editor-heading-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => editorFileInputRef.current?.click()}><UiIcon name="plus" /> 파일 추가</button>
              <button className="icon-text-button" type="button" disabled={busy} onClick={resetWorkspace}><UiIcon name="reset" /> 처음부터</button>
              <input ref={editorFileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleFileInput} />
            </div>
          </div>

          <div className="action-toolbar" aria-label="PDF 편집 작업">
            <div className="selection-summary">
              <strong>{selection.size ? `${selection.size}페이지 선택됨` : `전체 ${pages.length}페이지`}</strong>
              <button type="button" onClick={() => setSelection(selection.size === pages.length ? new Set() : new Set(pages.map((page) => page.id)))} disabled={busy || !pages.length}>
                {selection.size === pages.length && pages.length ? '선택 해제' : '전체 선택'}
              </button>
            </div>
            <div className="toolbar-actions">
              <button className="tool-button" type="button" disabled={busy || !pages.length} onClick={() => void runDownload('merge')}><UiIcon name="files" /> 병합</button>
              <button className="tool-button" type="button" disabled={busy || !pages.length} onClick={() => void runDownload('split')}><UiIcon name="split" /> 분할</button>
              <button className="tool-button" type="button" disabled={busy || !selection.size} onClick={() => void runDownload('extract')}><UiIcon name="scissors" /> 추출</button>
              <button className="tool-button danger" type="button" disabled={busy || !selection.size} onClick={deleteSelectedPages}><UiIcon name="trash" /> 삭제</button>
              <button className="download-button" type="button" disabled={busy || !pages.length} onClick={() => void runDownload('merge')}><UiIcon name="download" /> PDF 저장</button>
            </div>
          </div>

          {busy && (
            <div className="workspace-progress" role="status" aria-live="polite">
              <UiIcon name="loading" className="spin" />
              <span>{processing.message}</span>
              <div><i style={{ width: `${processing.progress}%` }} /></div>
              <b>{processing.progress}%</b>
            </div>
          )}

          <div className={`page-grid ${isDraggingFiles ? 'receiving-files' : ''}`} aria-label="PDF 페이지 목록">
            {pages.map((page, index) => {
              const selected = selection.has(page.id);
              return (
                <article
                  className={`page-card ${selected ? 'is-selected' : ''} ${dragOverPageId === page.id ? 'is-drag-over' : ''}`}
                  key={page.id}
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={`${page.sourceName} ${page.originalPageNumber}페이지${selected ? ', 선택됨' : ''}`}
                  tabIndex={0}
                  draggable={!busy}
                  onClick={(event) => togglePage(index, event.shiftKey)}
                  onKeyDown={(event) => handlePageKeyDown(event, index)}
                  onDragStart={(event) => { draggedPageIdRef.current = page.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', page.id); }}
                  onDragEnter={(event) => { event.preventDefault(); if (draggedPageIdRef.current) setDragOverPageId(page.id); }}
                  onDragOver={(event) => { if (draggedPageIdRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                  onDrop={(event) => { if (draggedPageIdRef.current) { event.preventDefault(); event.stopPropagation(); reorderPage(page.id); } }}
                  onDragEnd={() => { draggedPageIdRef.current = null; setDragOverPageId(null); }}
                >
                  <div className="page-card-top">
                    <span className="page-order">{index + 1}</span>
                    <span className="selection-check" aria-hidden="true">{selected ? <UiIcon name="check" /> : null}</span>
                  </div>
                  <div className="page-preview" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={page.thumbnail} alt="" draggable={false} />
                  </div>
                  <div className="page-info">
                    <div><strong title={page.sourceName}>{page.sourceName}</strong><span>원본 {page.originalPageNumber}페이지 · {page.rotation}°</span></div>
                    <UiIcon name="grip" className="drag-handle" />
                  </div>
                  <div className="page-move-controls" aria-label="페이지 순서 변경">
                    <button type="button" disabled={busy || index === 0} aria-label="한 칸 앞으로 이동" onClick={(event) => { event.stopPropagation(); movePage(index, -1); }}><UiIcon name="left" /></button>
                    <button type="button" disabled={busy || index === pages.length - 1} aria-label="한 칸 뒤로 이동" onClick={(event) => { event.stopPropagation(); movePage(index, 1); }}><UiIcon name="right" /></button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className={`drop-overlay ${isDraggingFiles ? 'visible' : ''}`} aria-hidden="true"><UiIcon name="upload" /><strong>PDF를 놓아 추가하세요</strong></div>
        </section>
      )}

      {!hasWorkspace && <footer><p><strong>마이PDF</strong>는 파일을 서버에 저장하거나 전송하지 않습니다.</p><p>© 2026 마이PDF</p></footer>}

      {hasWorkspace && (
        <nav className="mobile-action-bar" aria-label="모바일 PDF 작업">
          <button type="button" disabled={busy || !pages.length} onClick={() => void runDownload('merge')}><UiIcon name="files" /><span>병합</span></button>
          <button type="button" disabled={busy || !pages.length} onClick={() => void runDownload('split')}><UiIcon name="split" /><span>분할</span></button>
          <button type="button" disabled={busy || !selection.size} onClick={() => void runDownload('extract')}><UiIcon name="scissors" /><span>추출</span></button>
          <button className="danger" type="button" disabled={busy || !selection.size} onClick={deleteSelectedPages}><UiIcon name="trash" /><span>삭제</span></button>
        </nav>
      )}

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

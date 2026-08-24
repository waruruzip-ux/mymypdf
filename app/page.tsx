'use client';

import { ChangeEvent, DragEvent, FormEvent, useRef, useState } from 'react';
import {
  downloadDeletedPdf,
  downloadExtractedPdf,
  downloadMergedPdf,
  downloadSplitZip,
  formatBytes,
  inspectPdfFile,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_PAGES,
  parsePageExpression,
  parseSplitRanges,
  ProcessingState,
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
  inputLabel?: string;
  placeholder?: string;
  example?: string;
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
    title: '나눌 페이지 범위를 적어주세요',
    description: '쉼표로 구분한 각 범위가 하나의 PDF가 되어 ZIP으로 저장됩니다.',
    inputLabel: '나눌 페이지 범위',
    placeholder: '예: 1-3, 4-6, 7-10',
    example: '1-3, 4-6처럼 입력하면 두 개의 PDF로 나눠집니다.',
    button: '분할 ZIP 다운로드',
  },
  extract: {
    label: '추출',
    icon: 'scissors',
    title: '필요한 페이지 번호를 적어주세요',
    description: '입력한 순서대로 페이지만 모아 새 PDF를 만듭니다.',
    inputLabel: '추출할 페이지',
    placeholder: '예: 1, 3, 5-7',
    example: '한 페이지는 3, 여러 페이지는 1, 3, 5-7처럼 입력하세요.',
    button: '추출 PDF 다운로드',
  },
  delete: {
    label: '삭제',
    icon: 'trash',
    title: '빼고 싶은 페이지 번호를 적어주세요',
    description: '원본은 건드리지 않고, 입력한 페이지를 제외한 새 PDF를 만듭니다.',
    inputLabel: '삭제할 페이지',
    placeholder: '예: 2, 4-6',
    example: '입력한 페이지만 제외됩니다. 최소 한 페이지는 남아 있어야 해요.',
    button: '삭제 후 PDF 다운로드',
  },
};

function UiIcon({ name, className = '' }: { name: keyof typeof iconGlyphs; className?: string }) {
  return <span className={`ui-icon ${className}`} aria-hidden="true">{iconGlyphs[name]}</span>;
}

const idleProcessing: ProcessingState = { kind: 'idle', progress: 0, message: '' };

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
  const [pageExpression, setPageExpression] = useState('');
  const [processing, setProcessing] = useState<ProcessingState>(idleProcessing);
  const [notice, setNotice] = useState<Notice>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dragOverSourceId, setDragOverSourceId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorFileInputRef = useRef<HTMLInputElement>(null);
  const draggedSourceIdRef = useRef<string | null>(null);

  const busy = processing.kind !== 'idle';
  const hasWorkspace = sources.length > 0;
  const totalBytes = fileListSize(sources);
  const totalPages = totalPageCount(sources);
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? sources[0];
  const details = modeDetails[activeMode];

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
    setPageExpression('');
    setNotice(null);
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
    setSources((current) => {
      const next = current.filter((source) => source.id !== sourceId);
      if (selectedSourceId === sourceId) setSelectedSourceId(next[0]?.id ?? '');
      return next;
    });
    showNotice({ tone: 'success', text: '작업 목록에서 파일을 뺐습니다. 원본 파일은 그대로예요.' });
  }

  function resetWorkspace() {
    if (busy) return;
    setSources([]);
    setActiveMode('merge');
    setSelectedSourceId('');
    setPageExpression('');
    setNotice(null);
  }

  async function runAction(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!sources.length) {
      showNotice({ tone: 'error', text: '처리할 PDF를 먼저 추가해 주세요.' });
      return;
    }

    const processingKind: ProcessingState['kind'] =
      activeMode === 'merge' ? 'merging' :
      activeMode === 'split' ? 'splitting' :
      activeMode === 'extract' ? 'extracting' : 'deleting';
    const startMessage =
      activeMode === 'merge' ? '파일 순서대로 합치는 중' :
      activeMode === 'split' ? '입력한 범위대로 나누는 중' :
      activeMode === 'extract' ? '입력한 페이지를 추출하는 중' : '입력한 페이지를 제외하는 중';

    try {
      let pageIndexes: number[] = [];
      let splitRanges: ReturnType<typeof parseSplitRanges> = [];
      if (activeMode !== 'merge') {
        if (!selectedSource) throw new Error('작업할 PDF를 선택해 주세요.');
        if (activeMode === 'split') splitRanges = parseSplitRanges(pageExpression, selectedSource.pageCount);
        else pageIndexes = parsePageExpression(pageExpression, selectedSource.pageCount);
      }

      setProcessing({ kind: processingKind, progress: 2, message: startMessage });
      const updateProgress = (progress: number, message: string) =>
        setProcessing({ kind: processingKind, progress, message });

      if (activeMode === 'merge') await downloadMergedPdf(sources, updateProgress);
      else if (activeMode === 'split') await downloadSplitZip(selectedSource, splitRanges, updateProgress);
      else if (activeMode === 'extract') await downloadExtractedPdf(selectedSource, pageIndexes, updateProgress);
      else await downloadDeletedPdf(selectedSource, pageIndexes, updateProgress);

      const successText =
        activeMode === 'merge' ? '병합 PDF를 다운로드했습니다.' :
        activeMode === 'split' ? '분할 ZIP을 다운로드했습니다.' :
        activeMode === 'extract' ? '추출 PDF를 다운로드했습니다.' : '페이지를 제외한 새 PDF를 다운로드했습니다.';
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
            <span><UiIcon name="split" /> 범위별 분할</span>
            <span><UiIcon name="trash" /> 페이지 삭제</span>
          </div>
        </section>
      ) : (
        <section className="editor-shell" {...fileDropProps}>
          <div className="editor-heading">
            <div>
              <p className="editor-kicker"><UiIcon name="shield" /> 모든 작업은 이 기기에서만 처리됩니다</p>
              <h1>어떤 작업을 할까요?</h1>
              <p>병합은 파일 순서만 정하고, 나머지는 페이지 번호만 입력하면 됩니다.</p>
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
              <form className="range-form" onSubmit={(event) => void runAction(event)}>
                <label className="field-group">
                  <span>작업할 PDF</span>
                  <span className="select-wrap">
                    <select
                      value={selectedSource?.id ?? ''}
                      onChange={(event) => {
                        setSelectedSourceId(event.target.value);
                        setPageExpression('');
                      }}
                      disabled={busy}
                    >
                      {sources.map((source) => <option key={source.id} value={source.id}>{source.name} ({source.pageCount}페이지)</option>)}
                    </select>
                  </span>
                </label>
                <label className="field-group">
                  <span>{details.inputLabel}</span>
                  <input
                    className="page-expression"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    value={pageExpression}
                    placeholder={details.placeholder}
                    disabled={busy}
                    aria-describedby="page-expression-help"
                    onChange={(event) => setPageExpression(event.target.value)}
                  />
                </label>
                <p className="input-help" id="page-expression-help"><UiIcon name="check" /> {details.example}</p>
                <div className="selected-document-summary">
                  <span className="file-document-icon"><UiIcon name="file" /></span>
                  <span><strong>{selectedSource?.name}</strong><small>입력 가능 범위: 1-{selectedSource?.pageCount}페이지</small></span>
                </div>
                <button className="download-button range-submit" type="submit" disabled={busy || !pageExpression.trim()}><UiIcon name="download" /> {details.button}</button>
              </form>
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

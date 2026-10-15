"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Bot, ChevronLeft, Trash2 } from "lucide-react";

import { ReadingShareDialog } from "@/components/reading/reading-share-dialog";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { MOMENTS_UPDATED_EVENT, deleteMoment, loadMoments, type Moment } from "@/lib/moment-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { DiaryEntryFontPanel } from "./diary-entries-app";
import { useDiaryFont } from "./use-diary-font";
import { useDragToTrash } from "./use-drag-to-trash";

type MomentsAppProps = {
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type MomentBook = {
  characterId: string;
  characterName: string;
  avatar: string;
  moments: Moment[];
};

const BOOK_COVER_COUNT = 6;

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

/** 封面上的月.日；书只有手机半屏宽，带年份的话左边的段数会被挤成省略号 */
function formatMonthDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function momentDate(moment: Moment): string {
  return formatDate(moment.messageAt) || formatDate(moment.createdAt);
}

/** 纸条右上角那枚小标：正篇 / 番外 · 名字 */
function sourceLabel(moment: Moment): string {
  if (moment.source !== "extra") return "正篇";
  return moment.sourceTitle ? `番外 · ${moment.sourceTitle}` : "番外";
}

function clipText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function MomentsApp({ onBack, onNotice }: MomentsAppProps) {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [activeMoment, setActiveMoment] = useState<Moment | null>(null);
  const [sharingMoment, setSharingMoment] = useState<Moment | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Moment | null>(null);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const font = useDiaryFont("moment", notify);
  const trash = useDragToTrash<Moment>({
    enabled: Boolean(activeCharacterId),
    scrollRef: mainRef,
    onDrop: setDeleteCandidate,
  });

  useEffect(() => {
    const refresh = () => setMoments(loadMoments());
    refresh();
    setCharacters(loadCharacters());
    window.addEventListener(MOMENTS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(MOMENTS_UPDATED_EVENT, refresh);
  }, []);

  const books = useMemo<MomentBook[]>(() => {
    const map = new Map<string, Moment[]>();
    for (const moment of moments) {
      const list = map.get(moment.characterId);
      if (list) list.push(moment);
      else map.set(moment.characterId, [moment]);
    }
    return Array.from(map.entries()).map(([characterId, list]) => {
      const character = characters.find(item => item.id === characterId);
      return {
        characterId,
        characterName: character?.name || list[0].characterName,
        avatar: character?.avatar ?? "",
        moments: list,
      };
    });
  }, [moments, characters]);

  const activeBook = useMemo(
    () => (activeCharacterId ? books.find(book => book.characterId === activeCharacterId) ?? null : null),
    [activeCharacterId, books],
  );

  const removeMoment = useCallback((moment: Moment) => {
    deleteMoment(moment.id);
    setActiveMoment(current => current?.id === moment.id ? null : current);
    setDeleteCandidate(null);
    notify("已从片刻纪事里删掉这一段。");
  }, [notify]);

  /** 分享图的署名：说这句话的人，头像跟着 */
  const speakerAvatar = useCallback((moment: Moment): string | undefined => {
    if (moment.speaker === "user") return resolveUserIdentity(moment.characterId, "story")?.avatarUrl || undefined;
    return characters.find(item => item.id === moment.characterId)?.avatar || undefined;
  }, [characters]);

  return (
    <section className={`diary-app diary-entry-app ${trash.drag ? "is-entry-dragging" : ""}`} style={font.style}>
      <header className="diary-app-header diary-entry-header">
        <button
          type="button"
          className="diary-icon-btn"
          onClick={() => (activeBook ? setActiveCharacterId(null) : onBack())}
          aria-label="返回"
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{activeBook ? activeBook.characterName : "片刻纪事"}</h1>
          <p>{activeBook ? `共 ${activeBook.moments.length} 段` : "每个角色一本，点开翻阅"}</p>
        </div>
        <input
          ref={fontFileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
          className="hidden"
          onChange={font.upload}
        />
        <span className="diary-entry-header-actions">
          <button
            type="button"
            className="note-wall-menu-btn diary-font-upload-btn"
            onClick={() => setFontPanelOpen(true)}
            aria-label="片刻纪事字体设置"
            title="片刻纪事字体设置"
          >
            <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          </button>
        </span>
      </header>

      <main ref={mainRef} className="diary-entry-main">
        {moments.length === 0 ? (
          <div className="diary-entry-empty">
            <Bookmark size={34} strokeWidth={1.5} />
            <h2>还没有收下的片刻</h2>
            <p>在剧情正篇、番外里长按一段，点「收藏」就会收到这里。</p>
          </div>
        ) : activeBook ? (
          <div className="diary-entry-list">
            {activeBook.moments.map(moment => (
              <button
                key={moment.id}
                type="button"
                className={`diary-entry-card moment-card ${trash.drag?.item.id === moment.id ? "is-drag-source" : ""}`}
                draggable={false}
                onPointerDown={(event) => trash.onPointerDown(event, moment)}
                onPointerMove={trash.onPointerMove}
                onPointerUp={trash.onPointerUp}
                onPointerCancel={trash.onPointerCancel}
                onPointerLeave={trash.onPointerLeave}
                onContextMenu={event => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (trash.isClickSuppressed()) {
                    event.preventDefault();
                    return;
                  }
                  setActiveMoment(moment);
                }}
              >
                <MomentCardContent moment={moment} />
              </button>
            ))}
          </div>
        ) : (
          <div className="diary-shelf">
            {[0, 1].map(column => (
              <div className="diary-shelf-column" key={column}>
                {books.filter((_, index) => index % 2 === column).map(book => (
                  <MomentBookCover key={book.characterId} book={book} onOpen={() => setActiveCharacterId(book.characterId)} />
                ))}
              </div>
            ))}
          </div>
        )}
      </main>

      {fontPanelOpen ? (
        <DiaryEntryFontPanel
          title={font.label}
          hasCustomFont={font.hasCustomFont}
          scale={font.scale}
          onUpload={() => fontFileRef.current?.click()}
          onScaleChange={font.changeScale}
          onReset={font.reset}
          onClose={() => setFontPanelOpen(false)}
        />
      ) : null}

      {activeMoment ? (
        <MomentDetail
          moment={activeMoment}
          onClose={() => setActiveMoment(null)}
          onShare={() => setSharingMoment(activeMoment)}
        />
      ) : null}

      {sharingMoment ? (
        <ReadingShareDialog
          title="分享片段"
          filePrefix="片刻纪事"
          quoteParagraphs={sharingMoment.paragraphs}
          bookTitle={sharingMoment.source === "extra" && sharingMoment.sourceTitle ? sharingMoment.sourceTitle : sharingMoment.characterName}
          bookAuthor={sharingMoment.speakerName}
          chapterTitle={sharingMoment.source === "extra" ? "番外" : "正篇"}
          progressPercent={0}
          progressLabel={momentDate(sharingMoment)}
          annotations={[]}
          signature={{ name: sharingMoment.speakerName, avatar: speakerAvatar(sharingMoment) }}
          fonts={{ body: font.family, userAnnotation: font.family, charAnnotation: font.family }}
          onClose={() => setSharingMoment(null)}
        />
      ) : null}

      {deleteCandidate ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="moment-delete-title"
          onClick={() => setDeleteCandidate(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="moment-delete-title">删除这一段</h2>
            <p>只从片刻纪事里删掉，剧情里的原文不受影响。</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidate(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => removeMoment(deleteCandidate)}>
                <span className="note-wall-primary-content">
                  <span>删除</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        ref={trash.trashRef}
        className={`diary-entry-trash-bin ${trash.drag ? "is-visible" : ""} ${trash.drag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!trash.drag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {trash.drag ? (
        <div
          className="diary-entry-card moment-card diary-entry-drag-ghost"
          style={{
            left: trash.drag.x,
            top: trash.drag.y,
            width: trash.drag.width,
            minHeight: trash.drag.height,
          }}
        >
          <MomentCardContent moment={trash.drag.item} />
        </div>
      ) : null}
    </section>
  );
}

function MomentBookCover({ book, onOpen }: { book: MomentBook; onOpen: () => void }) {
  const latest = book.moments[0];
  return (
    <button
      type="button"
      className="diary-book"
      data-cover={hashText(book.characterId) % BOOK_COVER_COUNT}
      onClick={onOpen}
    >
      <span className="diary-book-spine" aria-hidden="true" />
      <span className="diary-book-frame" aria-hidden="true" />
      <span className="diary-book-label">
        <span className="diary-book-avatar">
          {book.avatar ? <img src={book.avatar} alt="" /> : <Bot size={20} />}
        </span>
        <strong>{book.characterName}</strong>
        <em>的片刻纪事</em>
      </span>
      <span className="diary-book-meta">
        <span>{book.moments.length} 段</span>
        <time>{formatMonthDay(latest.createdAt)}</time>
      </span>
    </button>
  );
}

function MomentCardContent({ moment }: { moment: Moment }) {
  return (
    <>
      <span className="diary-entry-card-kicker">{moment.source === "extra" ? "EXTRA" : "STORY"}</span>
      <span className="diary-entry-card-markers">
        <span className="diary-entry-marker">{sourceLabel(moment)}</span>
      </span>
      <span className="diary-entry-card-text">{clipText(moment.paragraphs.join(" "), 130)}</span>
      <span className="diary-entry-card-meta">
        <span>{moment.speakerName}</span>
        <time>{momentDate(moment)}</time>
      </span>
    </>
  );
}

function MomentDetail({ moment, onClose, onShare }: { moment: Moment; onClose: () => void; onShare: () => void }) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <article className="diary-entry-detail-paper" onClick={(event) => event.stopPropagation()}>
        <span className="diary-entry-paper-clip" aria-hidden="true">
          <span />
        </span>
        <div className="diary-entry-detail-scroll">
          <header>
            <div className="diary-entry-detail-topline">
              <span>{moment.source === "extra" ? "番外摘录" : "正篇摘录"}</span>
              <div className="diary-entry-detail-actions">
                <button type="button" onClick={onShare}>分享</button>
                <button type="button" onClick={onClose}>关闭</button>
              </div>
            </div>
            {moment.source === "extra" && moment.sourceTitle ? (
              <div className="diary-entry-detail-titleline">
                <span className="diary-entry-detail-markers">
                  <span className="diary-entry-marker">{sourceLabel(moment)}</span>
                </span>
              </div>
            ) : null}
          </header>
          <div className="diary-entry-blocks">
            {moment.paragraphs.map((paragraph, index) => (
              <p key={index} className="diary-entry-paragraph">{paragraph}</p>
            ))}
          </div>
          <footer className="diary-entry-detail-signature">
            <span>{moment.speakerName}</span>
            <time>{momentDate(moment)}</time>
          </footer>
        </div>
      </article>
    </div>
  );
}

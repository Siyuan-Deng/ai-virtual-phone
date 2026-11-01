"use client";

// 手记首页：TA的日记 / 我的日记 / 片刻纪事三张卡，长按可以拖动换顺序（顺序存着，下次进来还是这样）

import { useState, type ComponentType } from "react";
import { BookOpenText, Bookmark, ChevronLeft, NotebookPen, StickyNote } from "lucide-react";

import { useLongPressReorder } from "@/components/settings/use-long-press-reorder";
import { kvGet, kvSet } from "@/lib/kv-db";
import { DiaryEntriesApp } from "./diary-entries-app";
import { MomentsApp } from "./moments-app";
import { NoteWallApp } from "./note-wall-app";

type DiaryAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type DiaryView = "home" | "entries" | "myEntries" | "moments" | "notewall";

const NOTE_WALL_UI_ENABLED = false;

type HomeCard = {
  id: "entries" | "myEntries" | "moments";
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  desc: string;
  footer: string;
};

const HOME_CARDS: HomeCard[] = [
  { id: "entries", label: "THEIR DIARY", icon: BookOpenText, title: "TA的日记", desc: "角色写下的纸页和片段", footer: "SUNNY 24C / HUM 62%" },
  { id: "myEntries", label: "MY DIARY", icon: NotebookPen, title: "我的日记", desc: "我写下的纸页和片段", footer: "PRIVATE NOTES / FOR YOU" },
  { id: "moments", label: "OUR DIARY", icon: Bookmark, title: "片刻纪事", desc: "我们写下的纸页和片段", footer: "MOMENTS / BETWEEN US" },
];

const HOME_ORDER_KEY = "ai_phone_diary_home_order_v1";
const REORDER_GROUP = "diary-home";

/** 按存着的顺序排；没存过、或者以后多了新卡片，没排到的按原来的先后接在后面 */
function loadHomeCards(): HomeCard[] {
  let saved: string[] = [];
  try {
    const parsed = JSON.parse(kvGet(HOME_ORDER_KEY) || "[]") as unknown;
    if (Array.isArray(parsed)) saved = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // 存坏了就照默认顺序
  }
  const rank = (card: HomeCard) => {
    const index = saved.indexOf(card.id);
    return index === -1 ? saved.length + HOME_CARDS.indexOf(card) : index;
  };
  return [...HOME_CARDS].sort((a, b) => rank(a) - rank(b));
}

export function DiaryApp({ onClose, onNotice }: DiaryAppProps) {
  const [view, setView] = useState<DiaryView>("home");
  const [cards, setCards] = useState(loadHomeCards);
  const reorder = useLongPressReorder((_group, orderedIds) => {
    kvSet(HOME_ORDER_KEY, JSON.stringify(orderedIds));
    setCards(loadHomeCards());
  });
  const cardIds = cards.map((card) => card.id);
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(new Date()).toUpperCase();

  if (NOTE_WALL_UI_ENABLED && view === "notewall") {
    return <NoteWallApp onBack={() => setView("home")} onNotice={onNotice} />;
  }

  if (view === "entries") {
    return <DiaryEntriesApp kind="character" onBack={() => setView("home")} onNotice={onNotice} />;
  }

  if (view === "myEntries") {
    return <DiaryEntriesApp kind="user" onBack={() => setView("home")} onNotice={onNotice} />;
  }

  if (view === "moments") {
    return <MomentsApp onBack={() => setView("home")} onNotice={onNotice} />;
  }

  return (
    <section className="diary-app">
      <header className="diary-app-header">
        <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>手记</h1>
          <p>记录角色留下的话</p>
        </div>
        <span className="diary-header-spacer" />
      </header>

      <main className="diary-home">
        {reorder.order(REORDER_GROUP, cards).map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              className="diary-feature-card diary-feature-card-entry"
              onClick={() => setView(card.id)}
              {...reorder.itemProps(REORDER_GROUP, card.id, cardIds)}
            >
              <span className="diary-feature-punches diary-feature-punches-left" aria-hidden="true" />
              <span className="diary-feature-punches diary-feature-punches-right" aria-hidden="true" />
              <span className="diary-feature-card-head">
                <span className="diary-feature-label">{card.label}</span>
                <span className="diary-feature-number">{todayLabel}</span>
              </span>
              <span className="diary-feature-main">
                <span className="diary-feature-icon">
                  <Icon size={20} strokeWidth={1.55} />
                </span>
                <span>
                  <strong>{card.title}</strong>
                  <em>{card.desc}</em>
                </span>
              </span>
              <span className="diary-feature-bottom" aria-hidden="true">
                <span className="diary-feature-barcode" />
                <span className="diary-feature-weather">{card.footer}</span>
              </span>
            </button>
          );
        })}

        {NOTE_WALL_UI_ENABLED ? (
          <button type="button" className="diary-feature-card diary-feature-card-primary" onClick={() => setView("notewall")}>
            <span className="diary-feature-punches diary-feature-punches-left" aria-hidden="true" />
            <span className="diary-feature-punches diary-feature-punches-right" aria-hidden="true" />
            <span className="diary-feature-card-head">
              <span className="diary-feature-label">NOTES</span>
              <span className="diary-feature-number">{todayLabel}</span>
            </span>
            <span className="diary-feature-main">
              <span className="diary-feature-icon">
                <StickyNote size={20} strokeWidth={1.55} />
              </span>
              <span>
                <strong>便签墙</strong>
                <em>公开贴上的心情和留言</em>
              </span>
            </span>
            <span className="diary-feature-bottom" aria-hidden="true">
              <span className="diary-feature-barcode" />
              <span className="diary-feature-weather">CLOUDY 22C / HUM 68%</span>
            </span>
          </button>
        ) : null}
      </main>
    </section>
  );
}

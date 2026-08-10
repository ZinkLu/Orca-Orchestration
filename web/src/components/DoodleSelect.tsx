import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DoodleOption {
  value: string;
  label: string;
  /** Small secondary line under the label (e.g. a Run id under its objective). */
  hint?: string;
  disabled?: boolean;
}

interface PanelPos {
  /** Fixed-position anchor. When `up`, `bottom` is set instead of `top`. */
  up: boolean;
  top: number;
  bottom: number;
  left: number;
  width: number;
  /** Max height for the option list, clamped to the free space on the chosen side. */
  listMaxH: number;
}

/**
 * Hand-drawn replacement for the native <select>. The trigger is a crayon
 * sticker in the same vocabulary as the rest of the page (wonky radii,
 * sticker shadow, a chevron scribbled through the fine-grain filter); the
 * dropdown is a portal — .node-panel scrolls (overflow-y: auto) and would
 * clip an absolutely-positioned child, and the toolbar is no safer, so the
 * panel lives on document.body with fixed coordinates measured from the
 * trigger. Flips upward when there isn't room below, and re-measures on
 * scroll/resize while open.
 */
export function DoodleSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  loading = false,
  emptyText = "没有选项",
  size = "md",
  className,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DoodleOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Async list not here yet — shows 加载中… instead of the empty state. */
  loading?: boolean;
  emptyText?: string;
  /** sm for the toolbars, md (full width) for panels. */
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.hint ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  // A fresh search always starts at the top of the list.
  useEffect(() => setActive(0), [query]);
  // Options can shrink under us (the Run list is polled) — keep the highlight
  // on an option that still exists.
  useEffect(() => {
    if (active > filtered.length - 1) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const listCap = 264;
    const listMin = 120;
    const spaceBelow = window.innerHeight - r.bottom - gap - 12;
    const spaceAbove = r.top - gap - 12;
    const up = spaceBelow < listMin && spaceAbove > spaceBelow;
    const listMaxH = Math.max(listMin, Math.min(listCap, up ? spaceAbove : spaceBelow));
    const width = Math.min(Math.max(r.width, 210), window.innerWidth - 24);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({
      up,
      top: r.bottom + gap,
      bottom: window.innerHeight - r.top + gap,
      left,
      width,
      listMaxH,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // Global listeners while open: click-away, Escape, and re-anchoring. The
  // scroll listener must be capture-phase — the panel is fixed, but any
  // scrolling ancestor (.node-panel, the page) moves the trigger.
  useEffect(() => {
    if (!open) return;
    const raf = () => requestAnimationFrame(() => inputRef.current?.focus());
    const id = raf();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onMove = () => measure();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, measure]);

  // Keep the keyboard highlight visible without stealing scroll momentum.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function pick(o: DoodleOption) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[active];
      if (o) pick(o);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={
          `doodle-select doodle-select--${size}` +
          (open ? " doodle-select--open" : "") +
          (className ? ` ${className}` : "")
        }
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`doodle-select__value${current ? "" : " doodle-select__value--dim"}`}>
          {current ? current.label : placeholder}
        </span>
        {/* hand-scribbled chevron — the fine grain keeps a small glyph legible */}
        <svg className="doodle-select__chev" viewBox="0 0 14 9" aria-hidden="true" focusable="false">
          <path d="M1.5 1.5 C3.5 4 5 5.8 7 7.2 C9 5.8 10.5 4 12.5 1.5" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className={`doodle-select__panel${pos.up ? " doodle-select__panel--up" : ""}`}
            style={
              pos.up
                ? { bottom: pos.bottom, left: pos.left, width: pos.width }
                : { top: pos.top, left: pos.left, width: pos.width }
            }
            role="listbox"
          >
            <div className="doodle-select__search">
              <svg className="doodle-select__mag" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <circle cx="6" cy="6" r="4.3" />
                <path d="M9.6 9.6 L12.8 12.8" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="搜索…"
                aria-label="搜索选项"
                spellCheck={false}
              />
            </div>
            <div className="doodle-select__options" ref={listRef} style={{ maxHeight: pos.listMaxH }}>
              {loading ? (
                <div className="doodle-select__empty">加载中…</div>
              ) : filtered.length === 0 ? (
                <div className="doodle-select__empty">{query ? "没有匹配的选项" : emptyText}</div>
              ) : (
                filtered.map((o, i) => (
                  <div
                    key={o.value}
                    data-idx={i}
                    role="option"
                    aria-selected={o.value === value}
                    className={
                      "doodle-select__opt" +
                      (i === active ? " doodle-select__opt--active" : "") +
                      (o.value === value ? " doodle-select__opt--selected" : "") +
                      (o.disabled ? " doodle-select__opt--disabled" : "")
                    }
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    <span className="doodle-select__opt-text">
                      <span className="doodle-select__opt-label">{o.label}</span>
                      {o.hint && <span className="doodle-select__opt-hint">{o.hint}</span>}
                    </span>
                    {/* the chosen one gets signed off with a crayon tick */}
                    {o.value === value && (
                      <svg
                        className="doodle-select__check"
                        viewBox="0 0 16 14"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M2 7.5 L6 11.5 L14 2.5" pathLength={100} />
                      </svg>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

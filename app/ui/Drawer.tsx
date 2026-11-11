'use client';

/**
 * The menu that slides in from the left when the menu button is pressed.
 *
 * It closes with its own close button, with the Escape key, with a click
 * outside it, and when an entry is chosen. While it is open, the Tab key stays
 * inside it and the page behind does not scroll. When it closes, the keyboard
 * goes back to the button that opened it.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { MenuSection } from './menu';

interface DrawerProps {
  /** Also the id the menu button points to with aria-controls. */
  id: string;
  open: boolean;
  onClose: () => void;
  sections: readonly MenuSection[];
  /** The id of the entry that is showing now. */
  current: string;
  /** A small line at the bottom of the menu, for example the version. */
  foot?: string;
}

export function Drawer({ id, open, onClose, sections, current, foot }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      closeButton.current?.focus();
      // The page behind stops scrolling. Where a scrollbar takes up room, that room is
      // kept, so the page does not jump sideways when the scrollbar goes away.
      const body = document.body;
      const before = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      body.style.overflow = 'hidden';
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
      return () => {
        body.style.overflow = before.overflow;
        body.style.paddingRight = before.paddingRight;
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      // Some browsers do not put the keyboard on a button when it is clicked. Then
      // nothing was remembered, and the keyboard goes to the button that controls this menu.
      (opener.current ?? document.querySelector<HTMLElement>(`[aria-controls="${id}"]`))?.focus();
    }
    return undefined;
  }, [open, id]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Tab goes round inside the menu instead of leaving it for the page behind.
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className={`backdrop${open ? ' open' : ''}`} data-testid="menu-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        id={id}
        className={`drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        // A closed menu must not be reachable: not by keyboard, not by a screen reader.
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="drawer-head">
          <div>
            <div className="brand">Scrapy</div>
            <div className="soft">Web tools for AI agents</div>
          </div>
          <button ref={closeButton} type="button" className="icon" aria-label="Close menu" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
        <nav aria-label="Sections">
          {sections.map((section, index) => (
            <div className="drawer-section" key={section.title}>
              <h2 id={`${id}-section-${index}`}>{section.title}</h2>
              <ul aria-labelledby={`${id}-section-${index}`}>
                {section.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      aria-current={item.id === current ? 'page' : undefined}
                      onClick={(event) => {
                        // Choosing the part that is already showing only closes the menu.
                        if (item.id === current) event.preventDefault();
                        onClose();
                      }}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {foot && <div className="drawer-foot soft">{foot}</div>}
      </div>
    </>
  );
}

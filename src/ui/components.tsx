/** Briques d'interface partagees par les differentes vues. */
import { useEffect, useRef, type ReactNode } from 'react';
import type { AppError, Person, Shift, ShiftKind } from '../types';

/* ------------------------------------------------------------------ Modal */

interface ModalProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * Fenetre modale accessible : ferme sur Echap, piege le focus a l'interieur,
 * et restaure le focus sur l'element declencheur a la fermeture.
 */
export function Modal({ title, onClose, children }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;

      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    // Bloque le defilement de l'arriere-plan pendant l'ouverture.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Fermer">
            &#10005;
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Alerte */

type AlertTone = 'error' | 'success' | 'warn' | 'info';

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={`alert${tone === 'info' ? '' : ` alert--${tone}`}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {title !== undefined && <p className="alert__title">{title}</p>}
      {children}
    </div>
  );
}

/** Rend une `AppError` avec son message et sa piste de resolution. */
export function ErrorAlert({ error }: { readonly error: AppError }): ReactNode {
  return (
    <Alert tone="error" title={error.message}>
      {error.hint !== undefined && <p className="alert__hint">{error.hint}</p>}
    </Alert>
  );
}

/* ------------------------------------------------------------- Presentation */

/** Initiales d'un nom, pour les pastilles de la liste des collegues. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter((p) => p.length > 0);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + second).toUpperCase();
}

export function Avatar({ person }: { readonly person: Person }): ReactNode {
  return (
    <span className="person__avatar" style={{ background: person.color }} aria-hidden="true">
      {initials(person.displayName)}
    </span>
  );
}

/**
 * Couleur d'un poste : la couleur de la personne pour le travail, une teinte
 * neutre et desaturee pour les absences, afin que l'oeil distingue au premier
 * coup d'oeil les jours travailles des jours non travailles.
 */
export function shiftColor(kind: ShiftKind, personColor: string): string {
  switch (kind) {
    case 'rest': return '#9aa0a6';
    case 'leave': return '#1e8e3e';
    case 'sick': return '#d93025';
    case 'training': return '#f9ab00';
    default: return personColor;
  }
}

/** Libelle horaire compact : "08:00 - 16:00", "08:00" ou "Journée". */
export function timeRangeLabel(shift: Shift): string {
  if (shift.start === null) return 'Journée';
  return shift.end === null ? shift.start : `${shift.start} – ${shift.end}`;
}

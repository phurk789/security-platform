// The title row of an admin card: icon and title, an ⓘ that opens the card's longer explanation, and
// an action on the right (usually "+ Add …", which opens the card's form). Cards stay one line tall
// until someone needs the explanation or the form.
import { useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { useT } from '../i18n';

export function CardHead({ icon, title, help, action }: { icon: ReactNode; title: ReactNode; help?: ReactNode; action?: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="card-head">
        <h3>
          {icon} {title}
        </h3>
        {help && (
          <button
            type="button"
            className={`icon-btn card-help-btn ${open ? 'on' : ''}`}
            aria-expanded={open}
            aria-label={t('About this')}
            title={t('About this')}
            onClick={() => setOpen(!open)}
          >
            <Info size={15} />
          </button>
        )}
        {action && <div className="card-head-action">{action}</div>}
      </div>
      {help && open && <div className="card-help">{help}</div>}
    </>
  );
}

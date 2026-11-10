// Wide tables on a phone: each row shows as a card, each cell with its column's name beside it
// (styles.css, table.card-table under 600px). The names come from the table's own head, copied onto
// the cells as data-label after every render, so the table markup stays a plain table.
import { useLayoutEffect, useRef } from 'react';

export function useCardTable() {
  const ref = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const names = [...table.querySelectorAll(':scope > thead > tr:first-child > th')].flatMap((th) =>
      Array<string>((th as HTMLTableCellElement).colSpan || 1).fill(th.textContent?.trim() ?? ''),
    );
    for (const row of table.querySelectorAll(':scope > tbody > tr')) {
      let col = 0;
      for (const cell of row.children) {
        const name = (cell as HTMLTableCellElement).colSpan > 1 ? '' : (names[col] ?? '');
        if (name) {
          if (cell.getAttribute('data-label') !== name) cell.setAttribute('data-label', name);
        } else cell.removeAttribute('data-label');
        col += (cell as HTMLTableCellElement).colSpan || 1;
      }
    }
  });
  return ref;
}

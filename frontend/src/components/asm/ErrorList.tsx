import type { AsmDiagnostic } from '../../api';

interface Props {
  errors: AsmDiagnostic[];
}

export function ErrorList({ errors }: Props) {
  if (errors.length === 0) return null;
  return (
    <div className="asm-errors">
      <h3 className="asm-errors-title">Errors</h3>
      <ul className="asm-error-list">
        {errors.map((e, i) => (
          <li key={i} className="asm-error-item">
            {e.line != null && <span className="asm-error-loc">line {e.line}{e.col != null ? `:${e.col}` : ''}</span>}
            <span className="asm-error-msg">{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

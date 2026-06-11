interface Props {
  value: 'attasm' | 'intel';
  onChange: (v: 'attasm' | 'intel') => void;
}

export function SyntaxToggle({ value, onChange }: Props) {
  return (
    <div className="syntax-toggle">
      <span className="filter-label">Syntax</span>
      <div className="chips">
        <button
          className={value === 'attasm' ? 'chip active' : 'chip'}
          onClick={() => onChange('attasm')}
        >
          AT&T
        </button>
        <button
          className={value === 'intel' ? 'chip active' : 'chip'}
          onClick={() => onChange('intel')}
        >
          Intel
        </button>
      </div>
    </div>
  );
}

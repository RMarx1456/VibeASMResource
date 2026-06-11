import type { ListingLine } from '../../api';

interface Props {
  listing: ListingLine[];
  hex?: string;
  title?: string;
}

export function ListingPanel({ listing, hex, title = 'Listing' }: Props) {
  if (listing.length === 0) return null;

  return (
    <div className="section">
      <h2>{title}</h2>
      {hex && (
        <div className="asm-hex-dump">
          <span className="filter-label">Hex</span>
          <pre className="code small asm-hex">{hex}</pre>
        </div>
      )}
      <div className="table-scroll">
        <table className="asm-listing-table">
          <thead>
            <tr>
              <th>Address</th>
              <th>Bytes</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {listing.map((l, i) => (
              <tr key={i}>
                <td><code className="asm-addr">{l.address.toString(16).padStart(8, '0')}</code></td>
                <td><code className="asm-bytes">{l.bytes}</code></td>
                <td><code className="asm-src">{l.source}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

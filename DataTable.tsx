'use client';

import type { ReactNode } from 'react';
import { EmptyState, ErrorBanner, LoadingBlock, Pagination } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'start' | 'center' | 'end';
  /** Hidden on narrow screens. */
  hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  page?: number;
  totalPages?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  rowClassName?: (row: T) => string | undefined;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  onRowClick,
  emptyTitle,
  emptyHint,
  page,
  totalPages,
  total,
  onPageChange,
  rowClassName,
}: DataTableProps<T>) {
  return (
    <div className="table-wrap">
      <ErrorBanner message={error} onRetry={onRetry} />
      <div className={`table-scroll${loading && rows.length > 0 ? ' table-loading' : ''}`}>
        <table className="table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} style={{ width: column.width, textAlign: column.align ?? 'start' }} className={column.hideOnMobile ? 'hide-mobile' : undefined}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={[onRowClick ? 'row-clickable' : '', rowClassName?.(row) ?? ''].join(' ').trim() || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? 'start' }} className={column.hideOnMobile ? 'hide-mobile' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && rows.length === 0 ? <LoadingBlock /> : null}
        {!loading && !error && rows.length === 0 ? <EmptyState title={emptyTitle} hint={emptyHint} /> : null}
      </div>
      {page !== undefined && totalPages !== undefined && onPageChange && (total ?? 0) > 0 ? (
        <Pagination page={page} totalPages={totalPages} total={total ?? 0} onChange={onPageChange} />
      ) : null}
    </div>
  );
}

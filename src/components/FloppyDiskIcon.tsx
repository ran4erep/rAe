import React from 'react';

/** Classic 3.5-inch Amiga floppy diskette icon */
export const FloppyDiskIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M8 3v5h7V3" />
    <line x1="12.5" y1="4.8" x2="12.5" y2="6.2" />
    <path d="M7 21v-7h10v7" />
  </svg>
);

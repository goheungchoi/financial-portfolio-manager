import type {ReactNode} from 'react';
// Progressive disclosure: one short line is always visible; the full explanation opens on demand.
export function Note({summary,children}:{summary:string;children:ReactNode}){
  return <details className="note"><summary>{summary}</summary><div className="note-body">{children}</div></details>;
}

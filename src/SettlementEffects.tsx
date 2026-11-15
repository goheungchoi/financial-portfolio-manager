import {Row} from './SettingsUI';
import {Note} from './Note';
// The selected series' accounting corrections, days without a return and returns not yet verified, on the Performance
// page, kept apart from the returns above (stage 3.4; settlement clean-up S4a moved it out of the restatement code).
type Point={day:string;correction?:number;correctionItems?:{kind:string;usd:number|null}[];unavailable?:string[];settlement?:string[]};
export function SettlementEffects({points,money}:{points:Point[];money:(v:number)=>string}){
  const corrected=points.filter(p=>p.correction),missing=points.filter(p=>p.unavailable?.length),pending=points.filter(p=>p.settlement?.includes('pending')&&!p.unavailable);
  if(!corrected.length&&!missing.length&&!pending.length)return null;
  return <>{corrected.length>0&&<Row block title="Accounting corrections" hint="Settlement bookkeeping, not investment return. Kept out of returns and P/L."><span>{corrected.length} day{corrected.length>1?'s':''}</span></Row>}
    {corrected.length>0&&<Note summary={`Corrections by day · ${corrected.length}`}><table className="compact-table" aria-label="Accounting corrections"><thead><tr><th>Day</th><th>Correction</th><th>What</th></tr></thead><tbody>{corrected.map(p=><tr key={p.day}><td>{p.day}</td><td>{money(p.correction!)}</td><td>{[...new Set((p.correctionItems??[]).map(i=>i.kind))].join(', ')||'settlement change'}</td></tr>)}</tbody></table></Note>}
    {missing.length>0&&<Row block title="Days without a return" hint="Unknown, not zero: returns, drawdowns and gains spanning them are unavailable."><span className="role-tag unverified">{missing.length} day{missing.length>1?'s':''}</span></Row>}
    {missing.length>0&&<Note summary={`Why · ${missing.length}`}><ul aria-label="Days without a return">{missing.map(p=><li key={p.day}><b>{p.day}</b> {p.unavailable![0]}{p.unavailable!.length>1?` (+${p.unavailable!.length-1} more)`:''}</li>)}</ul></Note>}
    {pending.length>0&&<Row block title="Returns not yet verified" hint="A U.S. buy of these days is still awaiting settlement; the return is an estimate until it settles, by KIS evidence or after 3 business days."><span className="role-tag unverified">{pending.length} day{pending.length>1?'s':''}</span></Row>}</>;
}

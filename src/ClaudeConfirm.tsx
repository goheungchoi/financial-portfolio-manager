// Trading on Claude Opus 5.5, step D-3: the confirmation shown when a save would switch the trading model to Claude. Its
// lines come from src/claudeConfirmLines.mjs. Nothing is saved until "Trade with Claude".
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {claudeConfirmLines} from './claudeConfirmLines.mjs';

export function ClaudeConfirm({config,state,busy,onConfirm,onCancel}:{config:RuntimeConfig;state:RuntimeState;busy:boolean;onConfirm():void;onCancel():void}){
  return <div className="notice" role="dialog" aria-label="Trade with Claude Opus 5.5">
    <p><b>Trade with Claude Opus 5.5?</b></p>
    <ul>{(claudeConfirmLines(config,state) as string[]).map(line=><li key={line}>{line}</li>)}</ul>
    <div className="actions"><button className="primary" disabled={busy} onClick={onConfirm}>Trade with Claude</button><button disabled={busy} onClick={onCancel}>Cancel</button></div>
  </div>;
}

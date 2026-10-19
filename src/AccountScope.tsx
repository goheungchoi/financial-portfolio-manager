// History filter shared by Journal and Console: the connected account (default) or every account.
// Entries saved before accounts were recorded show only under All accounts.
export type AccountTag={key:string;label:string};
export type HistoryScope='account'|'all';
export function AccountScope({account,scope,onChange}:{account?:AccountTag|null;scope:HistoryScope;onChange(scope:HistoryScope):void}){
  if(!account)return null;
  return <select aria-label="Accounts" value={scope} onChange={e=>onChange(e.target.value as HistoryScope)}><option value="account">{account.label} only</option><option value="all">All accounts</option></select>;
}
export const accountName=(label?:string|null)=>label??'Earlier (account not recorded)';

// The taxpayer profile and which accounts it covers. Only what decides whether the ordinary rules apply is kept: no
// identifiers. Unanswered questions leave estimates labeled with the assumption; an answer outside the supported
// profile (non-resident, a special account, a major shareholder for Korean shares) makes the result unsupported
// instead of applying the ordinary formula.
const ACCOUNT_TYPES=['ordinary','isa','pension','corporate','ria','other'];
const DEFAULT_PROFILE={residency:null,longTermResident:null,majorShareholder:null,accounts:{}};
function validateProfile(value){
  if(!value||typeof value!=='object'||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_PROFILE,k)))throw new Error('INVALID_TAX_PROFILE');
  const next={...DEFAULT_PROFILE,...value};
  if(![null,'resident','non-resident'].includes(next.residency)||![null,true,false].includes(next.longTermResident)||![null,true,false].includes(next.majorShareholder))throw new Error('INVALID_TAX_PROFILE');
  if(!next.accounts||typeof next.accounts!=='object'||Array.isArray(next.accounts)||Object.keys(next.accounts).length>20)throw new Error('INVALID_TAX_PROFILE');
  for(const [key,a] of Object.entries(next.accounts))if(!/^[A-Za-z0-9:_-]{1,80}$/.test(key)||!a||!ACCOUNT_TYPES.includes(a.type)||typeof a.linked!=='boolean'||Object.keys(a).some(k=>!['type','linked'].includes(k)))throw new Error('INVALID_TAX_PROFILE');
  return next;
}
// The owner account of a broker account key: the U.S. side of a KIS account belongs to the same account.
const ownerAccount=accountKey=>String(accountKey??'').replace(/:US$/,'');
// Whether the ordinary rules apply to an account's trades, for a market ('KR' or 'US').
// Returns {status: supported|estimated|unsupported, reasons, assumptions}.
function applicability(profile,{accountKey,environment},market){
  const reasons=[],assumptions=[];
  // Practice accounts are estimated as if ordinary, for comparable outcomes; their trades never enter the tax ledger.
  if(environment!=='live')return {status:'estimated',reasons,assumptions:[`${environment==='mock'?'mock':'paper'} account: estimated as if an ordinary taxable account; not in the tax ledger`]};
  if(profile.residency==='non-resident')reasons.push('non-resident taxation is not implemented');
  else if(profile.residency==null)assumptions.push('Korean tax resident individual (not confirmed)');
  const account=profile.accounts[ownerAccount(accountKey)];
  if(account&&account.type!=='ordinary')reasons.push(`${account.type==='isa'?'ISA':account.type==='pension'?'pension or IRP':account.type==='ria'?'RIA':account.type} account rules are not implemented`);
  else if(!account)assumptions.push('ordinary taxable brokerage account (not confirmed)');
  if(market==='US'){if(profile.longTermResident===false)reasons.push('residents of under 5 of the last 10 years follow different overseas-gain rules');else if(profile.longTermResident==null&&profile.residency!=='non-resident')assumptions.push('resident in Korea for 5 or more of the last 10 years (not confirmed)');}
  if(market==='KR'){if(profile.majorShareholder===true)reasons.push('major-shareholder taxation of Korean shares is not implemented');else if(profile.majorShareholder==null)assumptions.push('minority shareholder of Korean listed companies (not confirmed)');}
  return {status:reasons.length?'unsupported':assumptions.length?'estimated':'supported',reasons,assumptions};
}
// The accounts whose realized gains count for this taxpayer: the connected live account and accounts linked as the same owner.
function taxpayerAccounts(profile,current){
  const owned=new Set(Object.entries(profile.accounts).filter(([,a])=>a.linked).map(([k])=>k));if(current?.environment==='live'&&current.accountKey)owned.add(ownerAccount(current.accountKey));return owned;
}
class TaxProfile {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS tax_profile(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');}
  get(){const row=this.db.prepare('SELECT payload FROM tax_profile WHERE id=1').get();return row?{...DEFAULT_PROFILE,...JSON.parse(row.payload)}:{...DEFAULT_PROFILE};}
  save(value){const next=validateProfile(value);this.db.prepare('INSERT INTO tax_profile VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(next));return this.get();}
}
module.exports={TaxProfile,DEFAULT_PROFILE,ACCOUNT_TYPES,validateProfile,applicability,taxpayerAccounts,ownerAccount};

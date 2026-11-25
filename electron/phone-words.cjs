// Phone control (1.6.0), stage P6: what the desktop says about phone control, from the switch, the PIN record and the
// phone service's status (phone-service.cjs setStatus: the worker's and gateway's states). One sentence and a tone:
// 'ok' (nothing to do), 'info' (in progress), 'action' (the user needs to do something). Home shows the line only for
// 'action'. Key names may appear (they are the provider file's field names); never a key's value, a token or an id.
const KEY_NAMES=['discordBotToken','discordApplicationId','discordServerId','discordChannelId','discordUserId'];
const names=v=>Array.isArray(v)?v.filter(k=>KEY_NAMES.includes(k)):[];
const list=a=>a.length<=1?a.join(''):`${a.slice(0,-1).join(', ')} and ${a.at(-1)}`;
const at=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST';
// view: {enabled, providerFile, pin:{set, locked}, service: the service's status or null, clockSuspect}.
function phoneLine(view){const v=view??{};
  if(!v.enabled)return {tone:'ok',text:'Off.'};
  if(!v.pin?.set)return {tone:'action',text:'Set a PIN: Start and the lost-order fixes need it.'};
  if(!v.providerFile)return {tone:'action',text:'Not running: choose your provider file in Connections.'};
  const s=v.service??{state:'stopped'};let line;
  switch(s.state){
    case 'not-set-up':{const missing=names(s.missing),invalid=names(s.invalid);
      line=missing.length||invalid.length?{tone:'action',text:`Not set up: ${[missing.length?`${list(missing)} missing`:'',invalid.length?`${list(invalid)} not valid`:''].filter(Boolean).join('; ')} in the provider file.`}
        :{tone:'action',text:'Not set up: the provider file could not be read.'};break;}
    case 'keys-ok':case 'connecting':line={tone:'info',text:'Connecting to Discord…'};break;
    case 'waiting':line={tone:'info',text:`Connection to Discord lost; trying again${Number.isFinite(s.waitMs)?` in ${Math.max(1,Math.round(s.waitMs/1000))} s`:''}.`};break;
    case 'worker-restarting':line={tone:'info',text:`Phone control stopped unexpectedly; restarting${Number.isFinite(s.waitMs)?` in ${Math.max(1,Math.round(s.waitMs/1000))} s`:''}.`};break;
    case 'bad-gateway-url':line={tone:'action',text:'Not connecting: Discord gave an unexpected address. Check for an app update.'};break;
    case 'refused':line=s.code===4004?{tone:'action',text:'Discord refused the bot token. Reset it in the Developer Portal and put the new one in the provider file.'}
      :{tone:'action',text:`Discord refused the connection${Number.isInteger(s.code)?` (code ${s.code})`:''}. Check the bot's setup in the Developer Portal.`};break;
    case 'commands-refused':line={tone:'action',text:`Connected, but Discord refused the command list${Number.isInteger(s.httpStatus)?` (HTTP ${s.httpStatus})`:''}. Check the server id and that the bot is in that server.`};break;
    case 'reply-refused':line={tone:'action',text:`A reply was refused by Discord${Number.isInteger(s.httpStatus)?` (HTTP ${s.httpStatus})`:''}. Check that the bot is in the server and can use the channel.`};break;
    case 'ready':case 'commands-registered':line=Number.isFinite(s.lastCommandAt)?{tone:'ok',text:`Connected. Last command at ${at(s.lastCommandAt)}.`}:{tone:'ok',text:'Connected. No command received yet: send /status from your phone.'};break;
    default:line={tone:'info',text:'Starting…'};}
  if(v.pin.locked)return {tone:'action',text:'Start and the lost-order fixes are locked after 5 wrong PINs. Unlock them in Engine settings.'};
  if(v.clockSuspect&&line.tone!=='action')return {tone:'action',text:'The PC clock may be wrong: phone commands looked too old or too new. Check the time in Windows settings.'};
  return line;}
module.exports={phoneLine,KEY_NAMES};

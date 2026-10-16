const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('portfolio', {
  forgetConnection: kind => ipcRenderer.invoke('connections:forget',kind),
  reconnectConnection: kind => ipcRenderer.invoke('connections:reconnect',kind),
  exportJournal: () => ipcRenderer.invoke('events:export'),
  getPortfolio:()=>ipcRenderer.invoke('portfolio:get'),refreshPortfolio:()=>ipcRenderer.invoke('portfolio:refresh'),setInstrumentMetadata:(symbol,value)=>ipcRenderer.invoke('portfolio:metadata',symbol,value),
  getCosts:()=>ipcRenderer.invoke('costs:get'),saveCosts:value=>ipcRenderer.invoke('costs:save',value),
  getExposure:()=>ipcRenderer.invoke('exposure:get'),saveExposurePolicy:(market,value)=>ipcRenderer.invoke('exposure:save-policy',market,value),setProductOverride:(symbol,factor)=>ipcRenderer.invoke('exposure:set-override',symbol,factor),
  getTaxSummary:()=>ipcRenderer.invoke('costs:tax-summary'),refreshCharges:()=>ipcRenderer.invoke('costs:refresh-charges'),
  usAction:(name,...args)=>['get','refresh','configure','stop','auto','auto-off','propose','submit','reconcile','link'].includes(name)?ipcRenderer.invoke('us:'+name,...args):Promise.reject(new Error('INVALID_REQUEST')),
  liveAction: (name,...args) => ['get','configure','stop','auto','auto-off','propose','submit','reconcile','link'].includes(name)?ipcRenderer.invoke('live:'+name,...args):Promise.reject(new Error('INVALID_REQUEST')),
  getCompany:symbol=>ipcRenderer.invoke('company:get',symbol),
  getResearch:(symbol,sections,refresh)=>ipcRenderer.invoke('research:company',symbol,sections,refresh),
  openFiling:url=>ipcRenderer.invoke('research:open-filing',url),
  getMarketOverview:refresh=>ipcRenderer.invoke('research:market',refresh),
  openChartWindow:symbol=>ipcRenderer.invoke('chart:pop-out',symbol),
  getMacro:()=>ipcRenderer.invoke('macro:get'),
  getAttention:()=>ipcRenderer.invoke('workspace:attention'),
  getUpdates:()=>ipcRenderer.invoke('update:get'),checkForUpdates:()=>ipcRenderer.invoke('update:check'),downloadUpdate:()=>ipcRenderer.invoke('update:download'),installUpdate:()=>ipcRenderer.invoke('update:install'),saveUpdateSettings:value=>ipcRenderer.invoke('update:settings',value),
  onUpdates:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('update:changed',listener);return ()=>ipcRenderer.removeListener('update:changed',listener);},
  refreshMacro:()=>ipcRenderer.invoke('macro:refresh'),
  startAutoTrading:token=>ipcRenderer.invoke('runtime:start',token),
  stopAutoTrading:()=>ipcRenderer.invoke('runtime:stop'),
  getRuntime: () => ipcRenderer.invoke('runtime:get'),
  configureRuntime: value => ipcRenderer.invoke('runtime:configure',value),
  reviewRuntime: () => ipcRenderer.invoke('runtime:review'),
  runScout: () => ipcRenderer.invoke('scout:run'),
  importProviders: () => ipcRenderer.invoke('runtime:providers'),
  refreshNews: () => ipcRenderer.invoke('runtime:news'),
  resetReviewWatches: () => ipcRenderer.invoke('runtime:reset-watches'),
  previewDigest: () => ipcRenderer.invoke('runtime:digest-preview'),
  getPerformance: () => ipcRenderer.invoke('performance:get'),
  addCashFlow: value => ipcRenderer.invoke('performance:add-flow', value),
  removeCashFlow: id => ipcRenderer.invoke('performance:remove-flow', id),
  refreshBenchmarks: () => ipcRenderer.invoke('performance:refresh-benchmarks'),
  getScoreboard: () => ipcRenderer.invoke('scoreboard:get'),
  refreshScoreboard: () => ipcRenderer.invoke('scoreboard:refresh'),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),
  getWatchQuotes: () => ipcRenderer.invoke('discovery:quotes'),
  searchSecurities: (query, market) => ipcRenderer.invoke('discovery:search', query, market),
  screenMarket: query => ipcRenderer.invoke('discovery:screen', query),
  updateWatchlist: (action, symbol, value) => ipcRenderer.invoke('discovery:watch', action, symbol, value),
  refreshSecurityMaster: () => ipcRenderer.invoke('discovery:refresh-master'),
  getOutcomeHistory:id=>ipcRenderer.invoke('runtime:outcome-history',id),
  lessonTrial:(action,id,value)=>ipcRenderer.invoke('runtime:lesson-trial',action,id,value),
  reviewLesson:(id,value)=>ipcRenderer.invoke('runtime:review-lesson',id,value),
  approveLesson: (id,approved) => ipcRenderer.invoke('runtime:lesson',id,approved),
  openNews: url => ipcRenderer.invoke('runtime:open-news',url),
  getPaper: () => ipcRenderer.invoke('paper:get'),
  configurePaperLoss: value => ipcRenderer.invoke('paper:loss',value),
  configurePaperCaps: value => ipcRenderer.invoke('paper:caps',value),
  proposePaper: command => ipcRenderer.invoke('paper:propose',command),
  submitPaper: id => ipcRenderer.invoke('paper:submit',id),
  pausePaper: paused => ipcRenderer.invoke('paper:pause',paused),
  cancelPaper: id => ipcRenderer.invoke('paper:cancel',id),
  getKis: () => ipcRenderer.invoke('kis:get'),
  importKis: () => ipcRenderer.invoke('kis:import'),
  refreshKis: () => ipcRenderer.invoke('kis:refresh'),
  disconnectKis: () => ipcRenderer.invoke('kis:disconnect'),
  getActivity: (kind,startDate,endDate) => ipcRenderer.invoke('kis:activity',kind,startDate,endDate),
  getEvents: () => ipcRenderer.invoke('events:get'),
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: theme => ipcRenderer.invoke('theme:set', theme),
  onTheme: callback => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  runDemo: () => ipcRenderer.invoke('demo:run'),
  getMarket: () => ipcRenderer.invoke('market:get'),
  pauseFeed: paused => ipcRenderer.invoke('market:pause',paused),
  getHistory: (symbol,interval) => ipcRenderer.invoke('market:history',symbol,interval),
  onMarket: callback => {
    const listener = (_event,state) => callback(state);
    ipcRenderer.on('market:changed',listener);
    return () => ipcRenderer.removeListener('market:changed',listener);
  },
  onEvents: callback => {
    const listener = (_event, events) => callback(events);
    ipcRenderer.on('events:changed', listener);
    return () => ipcRenderer.removeListener('events:changed', listener);
  }
});

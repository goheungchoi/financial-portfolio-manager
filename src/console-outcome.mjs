// AI console: runs the app logs as one finished line of its own, with no "Review completed" to close them (the user's
// screenshot, 2026-11-26: "Sectors assigned" stayed "In progress"). Their outcome is known from the line itself.
// Keep in step with the one-line Program entries in electron/automation.cjs.
const COMPLETED=['Sectors assigned','Kept the saved instructions for the next review'];
const SKIPPED=['Scout run skipped · ','Scout run dropped · ','Scout retry dropped · ','Market narrative skipped · '];
// events: the run's entries. 'Completed', 'Skipped', or null when the run is not one of these.
export function standaloneOutcome(events){
  if(!Array.isArray(events)||!events.length||!events.every(e=>e?.kind==='Program'))return null;
  if(events.every(e=>COMPLETED.includes(e.title)))return 'Completed';
  if(events.every(e=>typeof e.title==='string'&&SKIPPED.some(p=>e.title.startsWith(p))))return 'Skipped';
  return null;}
export const STANDALONE_TITLES={COMPLETED,SKIPPED};

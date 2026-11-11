// A render error inside one section shows one line in its place; the rest of the page stays (release gate 1.5.52, G5:
// a text fill time made the Movement section throw and blanked the whole window). Used around the Movement section and
// the Home Result tile only.
import {Component,type ReactNode} from 'react';
export class SectionBoundary extends Component<{label:string;className?:string;children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error:unknown){try{console.error(`${this.props.label} could not be shown:`,error);}catch{}}
  render(){return this.state.failed?<section className={this.props.className} aria-label={this.props.label} data-section-error="true"><p className="muted" role="status">This section could not be shown.</p></section>:this.props.children;}
}

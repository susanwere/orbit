import { useState } from "react";
import { Landing } from "./Landing.js";
import { Universe } from "./Universe.js";
import { ProjectCreation } from "./features/projects/ProjectCreation.js";
import type { ProjectCreationApi } from "./features/projects/project-api.js";

interface AppProps {
  /** Injected after authenticated session setup (ORB-54). Never pass tokens into components. */
  readonly projectApi?: ProjectCreationApi;
}
export function App({projectApi}:AppProps) {
  const [page,setPage]=useState<"landing"|"create"|"universe">("landing");
  if(page==="universe")return <Universe onExit={()=>setPage("landing")}/>;
  if(page==="create"&&projectApi)return <ProjectCreation api={projectApi} onCancel={()=>setPage("landing")}
    onCreated={()=>setPage("universe")}/>;
  return <Landing onEnter={()=>setPage(projectApi?"create":"universe")}/>;
}

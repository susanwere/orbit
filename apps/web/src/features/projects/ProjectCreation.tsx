import "./project-creation.css";
import { useState, type FormEvent } from "react";
import type { CreatedProject, ProjectCreationApi } from "./project-api.js";
import { ProjectApiError } from "./project-api.js";

interface Props {
 readonly api:ProjectCreationApi;
 readonly onCreated:(project:CreatedProject)=>void;
 readonly onCancel?:()=>void;
}
/**
 * Project can be created without GitHub. Repository registration is a separate
 * mutation; failure does not discard the newly created project or form data.
 */
export function ProjectCreation({api,onCreated,onCancel}:Props){
 const [name,setName]=useState("");
 const [repository,setRepository]=useState("");
 const [phase,setPhase]=useState<"idle"|"creating"|"connecting"|"error">("idle");
 const [error,setError]=useState<string|null>(null);
 const [created,setCreated]=useState<CreatedProject|null>(null);
 const busy=phase==="creating"||phase==="connecting";
 async function submit(event:FormEvent<HTMLFormElement>){
   event.preventDefault();
   if(busy)return;
   const trimmed=name.trim();
   if(!trimmed){setError("Enter a project name.");return}
   setError(null);
   let project=created;
   if(!project){
     setPhase("creating");
     try{project=await api.createProject(trimmed);setCreated(project)}
     catch(e){setError(e instanceof ProjectApiError?e.message:"Project creation failed.");setPhase("error");return}
   }
   if(repository.trim()){
     setPhase("connecting");
     try {await api.connectRepository(project.id,repository.trim())}
     catch(e){setError((e instanceof ProjectApiError?e.message:"Repository connection failed.")+" Your project was saved. Retry to connect its repository.");setPhase("error");return}
   }
   setPhase("idle");onCreated(project);
 }
 return <main className="project-create-page">
   <form onSubmit={event=>{void submit(event)}} className="project-create-form" aria-labelledby="create-project-heading">
     <p className="eyebrow">ORBIT / NEW PROJECT</p>
     <h1 id="create-project-heading">Start with intent.</h1>
     <p>Give the project a name. Connecting an existing GitHub repository is optional.</p>
     <label htmlFor="orbit-project-name">Project name</label>
     <input id="orbit-project-name" autoFocus value={name} onChange={e=>setName(e.target.value)}
       maxLength={120} required disabled={Boolean(created)||busy} placeholder="HN Jobs Viewer" />
     <label htmlFor="orbit-project-repo">GitHub repository <span>(optional)</span></label>
     <input id="orbit-project-repo" value={repository} onChange={e=>setRepository(e.target.value)}
       placeholder="owner/repository or https://github.com/owner/repository" disabled={busy} />
     <p className="project-create-help">An empty project is valid. Repositories can be connected later.</p>
     {created&&<p role="status">Project saved. You can finish or retry connecting its repository.</p>}
     {error&&<p role="alert" className="project-create-error">{error}</p>}
     <div className="project-create-actions">
       {onCancel&&<button type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
       <button type="submit" className="cta-primary" disabled={busy}>
         {phase==="creating"?"Creating…":phase==="connecting"?"Connecting repository…":created?"Continue":"Create project"}
       </button>
       {created&&<button type="button" onClick={()=>onCreated(created)} disabled={busy}>Continue without repository</button>}
     </div>
   </form>
 </main>;
}

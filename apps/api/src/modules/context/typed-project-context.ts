import { DomainError, type JsonValue, type ProjectContext } from "@orbit/domain";

export interface PaginationContext {
  readonly mode: "load_more" | "infinite_scroll";
  readonly batchSize: number;
  readonly infiniteScroll: boolean;
}
/** Keep existing JSONB context versions readable while requiring typed edits. */
export function paginationFromEvidence(evidence: string): PaginationContext | null {
  if (!/\bload more\b/i.test(evidence) || !/\b(?:rather than|instead of|no)\s+infinite scroll\b/i.test(evidence))
    return null;
  const batch=evidence.match(/\b(?:fetch|batches? of)\s+(\d{1,3})\s+jobs\b/i);
  if(!batch)return null;
  const size=Number(batch[1]);
  if(!Number.isSafeInteger(size)||size<1||size>100)return null;
  return {mode:"load_more",batchSize:size,infiniteScroll:false};
}
export function validateProjectContextAttributes(context: ProjectContext):void{
  const engineering=context.attributes.engineeringConstraints;
  if(engineering===undefined)return;
  if(typeof engineering!=="object"||engineering===null||Array.isArray(engineering))
    throw new DomainError("invalid_context_schema","Engineering constraints must be an object.");
  const pagination=(engineering as Record<string,JsonValue>).pagination;
  if(pagination===undefined)return;
  if(typeof pagination!=="object"||pagination===null||Array.isArray(pagination))
    throw new DomainError("invalid_context_schema","Pagination constraints must be an object.");
  const p=pagination as Record<string,JsonValue>;
  if(!["load_more","infinite_scroll"].includes(String(p.mode))||
     !Number.isSafeInteger(p.batchSize)||typeof p.batchSize!=="number"||
     p.batchSize<1||p.batchSize>100||typeof p.infiniteScroll!=="boolean"||
     p.infiniteScroll!==(p.mode==="infinite_scroll"))
    throw new DomainError("invalid_context_schema","Invalid pagination policy.");
}

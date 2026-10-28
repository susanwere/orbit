import { describe, expect, it } from "vitest";
import { paginationFromEvidence, validateProjectContextAttributes } from "../src/modules/context/typed-project-context.js";
import { generateContextChangeProposal } from "../src/modules/context/context-change-generator.js";

describe("typed decision context",()=>{
  it("derives actionable load-more only from explicit source evidence",()=>{
    expect(paginationFromEvidence("Fetch 20 jobs initially and use explicit Load More rather than infinite scroll."))
      .toEqual({mode:"load_more",batchSize:20,infiniteScroll:false});
    expect(paginationFromEvidence("Maybe we could use Load More?")).toBeNull();
    expect(paginationFromEvidence("Fetch 999 jobs and use Load More instead of infinite scroll")).toBeNull();
  });
  it("rejects inconsistent machine-readable constraint values",()=>{
    expect(()=>validateProjectContextAttributes({projectId:"p",originalIntentId:"i",currentIntent:"x",constraints:[],
      attributes:{engineeringConstraints:{pagination:{mode:"load_more",batchSize:20,infiniteScroll:true}}}}))
      .toThrowError(expect.objectContaining({code:"invalid_context_schema"}));
  });
  it("preserves provenance with a typed review operation",()=>{
    const proposal=generateContextChangeProposal({
      id:"change",organizationId:"org",projectId:"p",decisionProposalId:"proposal",
      baseContextVersion:{id:"v1",organizationId:"org",projectId:"p",versionNumber:1,
        contentHash:"hash",createdAt:"2026-10-28T12:00:00Z",
        content:{projectId:"p",originalIntentId:"i",currentIntent:"Jobs",constraints:[],attributes:{}}},
      candidate:{confidence:0.9,title:"Use Load More",rationale:"Reduce load",
        scope:[],alternatives:[],
        evidenceQuote:"Fetch 20 jobs initially and use explicit Load More rather than infinite scroll"},
      createdAt:"2026-10-28T12:00:00Z",
    });
    expect(proposal.operations).toHaveLength(2);
    expect(proposal.resultingContextPreview.attributes.engineeringConstraints)
      .toEqual({pagination:{mode:"load_more",batchSize:20,infiniteScroll:false}});
  });
});

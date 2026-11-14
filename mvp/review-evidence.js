/* Executed evidence, kept separate from the visual similarity map. Uses app.js escaping. */
function artifactButton(name, label) {
  return typeof name === 'string' && /^[\w.-]+$/.test(name)
    ? `<button class="link" data-art="${esc(name)}">${esc(label)}</button>` : '';
}
function evidenceLinks(b, ids = []) {
  return [...new Set(ids)].map(id => {
    const e = (b.evidence || []).find(e => e.id === id);
    return e ? artifactButton(e.artifact, `${e.version} evidence`) : '';
  }).filter(Boolean).join(' · ');
}
function claimEvidenceHTML(claims) {
  return claims.map(c=>`<details class="res"><summary>${esc(CLAIM[c.status]?.[1] || c.status)} · ${esc(c.text)}</summary><div class="li2"><p>${esc(c.detail || 'No further detail recorded')}</p><p>${(c.evidence || []).map(e=>artifactButton(e.artifact,e.label)).join(' · ')}</p></div></details>`).join('');
}
function reviewEvidenceHTML(b) {
  const contract = b.contract, v = b.verdict || {}, budget = b.budget || {};
  const sections = [];
  sections.push(`<div class="sec"><h3>Evidence scope</h3><p class="lead">Original commit: <code>${esc(b.input?.proposed || b.pr?.head)}</code><br>Historical base: <code>${esc(b.input?.historicalBase || 'not recorded')}</code><br>${esc(b.environment?.scope || v.score?.scope || 'Scope not recorded')}</p><p>${artifactButton('pipeline.json', 'Complete case file')}</p></div>`);
  const pending = v.pending || [], limits = [...(v.auditWarnings || []), ...(v.residualRisks || [])];
  sections.push(`<div class="sec"><h3>Approval blockers <span>${pending.length}</span></h3>${pending.length ? pending.map(p=>`<p class="lead">${esc(p)}</p>`).join('') : '<p class="lead">No blockers recorded for this scope. Residual risks still require human review.</p>'}${limits.length ? `<details class="more2"><summary>Audit warnings and residual risks · ${limits.length}</summary>${limits.map(p=>`<p class="lead">${esc(p)}</p>`).join('')}</details>` : ''}</div>`);
  if (contract) sections.push(`<div class="sec"><h3>Testable contract <span>${contract.expectations.length}</span></h3><p class="lead">Built from requirements and prior sources, not from agreement with the patch.</p>${contract.expectations.map(e=>{
    const supports = (v.support || []).filter(s=>s.expectation === e.id);
    const findings = (v.findings || []).filter(f=>f.expectations?.includes(e.id));
    const ids = [...supports.flatMap(s=>s.evidence || []), ...findings.flatMap(f=>(f.outcomes || []).filter(o=>o.version === 'original').map(o=>o.evidence))];
    return `<details class="res"><summary>${esc(e.id)} · ${esc(e.status)}${e.critical ? ' · critical' : ''}</summary><div class="li2"><p>${esc(e.behavior)}</p>${e.sources.map(r=>`<p><b>${esc(r.id)}</b>: ${esc(r.quote)}</p>`).join('')}<p><b>Execution</b>: ${v.verified?.includes(e.id) ? 'supported in declared scope' : 'not verified; inspect findings and blockers'}</p><p>${supports.flatMap(s=>s.tests || []).map(esc).join(', ')}</p><p>${evidenceLinks(b,ids)}</p></div></details>`;
  }).join('')}<p>${artifactButton('contract.json','Contract and source excerpts')}</p></div>`);
  sections.push(`<div class="sec"><h3>Executed tests <span>${(b.evidence || []).length} results</span></h3><p class="lead">A generated patch is not a passing implementation. Candidate failures alone do not condemn the original.</p>${(b.evidence || []).map(e=>{
    const failures = (e.tests || []).filter(t=>t.outcome === 'Failed');
    return `<details class="res"><summary>${esc(e.version)} · ${esc(e.status)}<span>${e.ran ?? 0} tests</span></summary><div class="li2"><p>${esc(e.scope)} · ${e.executionComplete === false ? 'execution incomplete' : e.executionComplete === true ? 'execution complete' : 'completion not recorded'}${e.reused ? ' · cached result, not an independent repetition' : ''}</p>${e.error ? `<p>${esc(e.error)}</p>` : ''}${failures.map(t=>`<p><b>${esc(t.name)}</b></p><pre class="code">${esc(t.error || 'See execution log')}</pre>`).join('')}<p>${artifactButton(e.artifact,'Result')} · ${artifactButton(e.log,'Execution log')} ${(e.trx || []).map((f,i)=>artifactButton(f,`TRX ${i+1}`)).join(' · ')}</p></div></details>`;
  }).join('')}${b.l2?.newTests?.length ? `<details class="more2"><summary>Red before / green after · ${b.l2.newTests.length} cases</summary>${b.l2.newTests.map(t=>`<p class="lead"><b>${esc(t.name)}</b><br>Base: ${esc(t.red)} · Original: ${esc(t.green)}</p>`).join('')}</details>` : ''}</div>`);
  if (b.candidates?.length) sections.push(`<div class="sec"><h3>Candidate provenance · Entire</h3><p class="lead">Checkpoints record our candidate sessions. They do not recover a missing historical prompt or certify correctness.</p>${b.candidates.map(c=>`<details class="res"><summary>${esc(c.id)} · ${esc(c.checkpoint?.status || 'not captured')}</summary><div class="li2"><p>Model: ${esc(c.model)}${c.modelFallback ? `<br>Requested: ${esc(c.requestedModel)} · substituted` : ''}</p><p>Commit: <code>${esc(c.commit || 'not recorded')}</code><br>Checkpoint: <code>${esc(c.checkpoint?.id || 'not recorded')}</code></p><p>${esc(c.strategy || c.reason || '')}</p><p>Parents: ${esc(c.parents?.join(', ') || 'historical base')} · Original patch visible: ${c.isolation?.proposedPatchVisible === false ? 'no' : 'not confirmed'}</p><p>${artifactButton(c.patch,`${c.id} patch`)} · ${artifactButton(c.checkpoint?.metadata,`${c.id} checkpoint`)} · ${artifactButton(c.checkpoint?.transcript,`${c.id} transcript`)}</p></div></details>`).join('')}</div>`);
  const restored = (b.candidates || []).filter(c=>c.continuedFrom);
  if (restored.length) sections.push(`<div class="sec"><h3>Restored candidate sessions</h3>${restored.map(c=>`<p class="lead">${esc(c.id)} restored from ${esc(c.continuedFrom)}.<br>Its Entire checkpoint belongs to the captured source commit <code>${esc(c.restoredFromCommit)}</code>; the current commit records restoration. Test results are recalculated.</p>`).join('')}</div>`);
  const attacks = b.attacks || [];
  if (attacks.length) sections.push(`<div class="sec"><details class="more2"><summary>Attack scenarios and admission · ${attacks.length}</summary>${attacks.map(a=>`<div class="q"><p><b>${esc(a.id)} · ${esc(a.status)}</b></p><p class="lead">Expected: ${esc(a.expected || '')}<br>Contract: ${esc(a.expectations?.join(', ') || 'not grounded')}</p><p class="lead">${esc(a.defense?.reason || a.pendingReason || a.error || '')}</p><p>${artifactButton(`${a.id}.json`,'Scenario and defense')}</p></div>`).join('')}</details></div>`);
  if (budget.accounting?.usageIncomplete || budget.usageIncomplete || budget.accounting?.unknownReserved || b.continuation) sections.push(`<div class="sec"><h3>Token accounting</h3><p class="lead">${budget.usageIncomplete || budget.accounting?.usageIncomplete ? 'Usage is incomplete. ' : ''}${budget.accounting?.unknownReserved ? `${esc(budget.accounting.unknownReserved)} tokens reserved for attempts without confirmed usage. ` : ''}${b.continuation ? `Continued from ${esc(b.continuation.runId)}; ${esc(budget.inheritedTokens ?? 'unknown')} inherited tokens, ${esc(budget.cumulativeTokens ?? 'unknown')} cumulative tokens. Tests were executed again.` : ''}</p></div>`);
  return sections.join('');
}

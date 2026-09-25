// Scratch: reply built from the REAL reconcile output. Hand over for deletion.
const {planDoc}=require('./netlify/functions/lib/compliance-doc.js');
const {buildReply}=require('./netlify/functions/lib/disclosure-reply.js');
const VICTORIA_DOC=['DISCLOSURES','- DIA','- ESD','- WHSD',
'- SFLS - If broker does not require it, get an email from the TC','- Property Profile',
'- MLS CLIENT TO SIGN','- LA AVID','- BA AVID','- WCMD or CMD',
'- Earthquake Booklet Receipt (check if we got the brokerage version)','- MCA','- SBSA','- WDFA',
'- Brokerage Affiliate Disclosures (If any) - Compass Playhouse District (680 E Colorado Blvd)',
'- Contingency Release (s)','- NHD Receipt Signed','- LPD 1978','- Property Inspections or BIW',
'- Termite inspection or BIW','- VP'].join('\n');
const VICTORIA_FILES=['BA AVID - need SS.pdf','LAD - FX.pdf','NHD - FX.pdf','Compass Disc - SS(FX).pdf',
'Compass Disc - BUYER REFUSAL.pdf','DIA - Disclosure Information Advisory - FX.pdf',
'ESD - Exempt Seller Disclosure - FX.pdf','WHSD - Water Heater and Smoke Alarm Statement of Compliance - FX.pdf',
'WCMD - Water-Conserving Plumbing Fixtures and Carbon Monoxide Detector Advisory - FX.pdf',
'EQ Booklet Receipt - FX.pdf','SBSA - Statewide Buyer and Seller Advisory - FX.pdf',
'SFLS - Square Footage and Lot Size Advisory and Disclosure - FX.pdf','Property Profile - FX.pdf',
'LPD - Lead-Based Paint and Lead-Based Paint Hazards Disclosure, Acknowledgment and Addendum - FX.pdf',
"AB - Buyer's Affidavit - FX.pdf",'AC - Confirmation of Real Estate Agency Relationships - FX.pdf'];

/** What the Doc still says after the write: the lines it did not strike. */
function outstandingFrom(plan){
  return plan.lines
    .filter(l=>l.action==='keep'||l.action==='annotate'||l.action==='review')
    .map(l=>({text: l.action==='annotate' ? l.to : l.text, action:l.action}));
}
const plan=planDoc(VICTORIA_DOC,VICTORIA_FILES);
const outstanding=outstandingFrom(plan);
const r=buildReply({address:'834 Victoria Ln, Sugarloaf, CA 92386',outstanding,senderName:'Dana Whitfield'});
const strip=(h)=>h.replace(/<\/p>/g,'\n').replace(/<li>/g,'   ').replace(/<\/li>/g,'\n')
  .replace(/<b>|<\/b>|<ul>|<\/ul>|<p>/g,'').split('\n').map(l=>l.trimEnd())
  .filter((l,i,a)=>!(l===''&&a[i-1]==='')).join('\n');
console.log('SUBJECT: '+r.subject+'   (open lines: '+r.asks+')');
console.log('-'.repeat(70));
console.log(strip(r.htmlBody));
console.log('-'.repeat(70));
console.log('per-line source:');
for(const o of outstanding) console.log('  ['+o.action.padEnd(8)+'] '+o.text);

// Scratch: render the reply for both real deliveries. Hand over for deletion.
const {buildReply}=require('./netlify/functions/lib/disclosure-reply.js');
const f=(code,name,status)=>({code,name,status});
const CASES={
 '834 Victoria Ln, Sugarloaf, CA 92386':{forms:[
   f('DIA','Disclosure Information Advisory','FX'),f('ESD','Exempt Seller Disclosure','FX'),
   f('WHSD','Water Heater and Smoke Alarm Statement of Compliance','FX'),
   f('WCMD','Water-Conserving Plumbing Fixtures and Carbon Monoxide Detector Advisory','FX'),
   f('','EQ Booklet Receipt','FX'),f('SBSA','Statewide Buyer and Seller Advisory','FX'),
   f('SFLS','Square Footage and Lot Size Advisory and Disclosure','FX'),
   f('','Property Profile','FX'),f('LPD','Lead-Based Paint and Lead-Based Paint Hazards Disclosure','FX'),
   f('AB',"Buyer's Affidavit",'FX'),f('AC','Confirmation of Real Estate Agency Relationships','FX')],
   senderName:'Dana Whitfield',unsortedPages:[],outOfSequence:[]},
 '1333 S Beverly Glen Blvd #902, Los Angeles, CA 90024':{forms:[
   f('WBSA','Wooden Balconies and Stairs Addendum','FX'),
   f('','Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures','NeedSS'),
   f('','Privacy Notice for Coldwell Banker Realty Clients','FX'),
   f('','Affiliated Business Arrangement Disclosure Statement','NeedSS'),
   f('FHDA','Fair Housing and Discrimination Advisory','NeedSS'),
   f('RCSD-S','Representative Capacity Signature Disclosure','FX'),
   f('MCA','Market Conditions Advisory','FX'),
   f('','Natural Hazard Disclosure Statement','NeedSS+LA'),
   f('','EQ Booklet Receipt','FX'),f('TA','Trust Advisory','FX'),
   f('','Affiliated Business Disclosure','NeedReview'),
   f('TDS','Real Estate Transfer Disclosure Statement','FX'),
   f('AVID-BA','Agent Visual Inspection Disclosure','NeedSS'),
   f('SPQ','Seller Property Questionnaire','FX'),
   f('WHSD','Water Heater and Smoke Alarm Statement of Compliance','NeedSS'),
   f('LPD','Lead-Based Paint and Lead-Based Paint Hazards Disclosure','FX')],
   senderName:'Lesley Ann Carter',unsortedPages:[],
   outOfSequence:[{filename:'a'},{filename:'b'}]},
};
const strip=(h)=>h.replace(/<\/p>/g,'\n').replace(/<li>/g,'  - ').replace(/<\/li>/g,'\n')
  .replace(/<b>|<\/b>/g,'').replace(/<ul>|<\/ul>/g,'').replace(/<p>/g,'')
  .split('\n').map(l=>l.trimEnd()).filter((l,i,a)=>!(l===''&&a[i-1]==='')).join('\n');
for(const [addr,args] of Object.entries(CASES)){
  const r=buildReply({address:addr,...args});
  console.log('='.repeat(74));
  console.log('SUBJECT: '+r.subject);
  console.log('asks of them: '+r.asks);
  console.log('-'.repeat(74));
  console.log(strip(r.htmlBody));
}

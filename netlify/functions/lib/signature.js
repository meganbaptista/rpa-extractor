// netlify/functions/lib/signature.js
//
// Megan's branded Gmail signature, for anything this codebase drafts under her
// name. Georgia, teal rule, photo, pink site link - it has to match what she
// sends by hand, or a drafted reply reads as coming from somewhere else.
//
// The photo `src` is a Google-hosted URL pulled from her sent mail. If it ever
// stops rendering, pull a current sent email and take the fresh <img src>.
const SIGNATURE_HTML = '<br>-- <br><div dir="ltr"><div dir="ltr" style="margin-left:0pt"><table style="border:none;border-collapse:collapse"><colgroup><col width="166"><col width="458"></colgroup><tbody><tr style="height:171pt"><td style="border-right:1.5pt solid rgb(32,195,212);vertical-align:top;padding:5pt"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt"><span style="font-size:11pt;font-family:Georgia;color:rgb(0,0,0);vertical-align:baseline"><img src="https://lh5.googleusercontent.com/syzG9xfX8zPsMbrPVZ7hEImywj4ydD1T6nBSrXSBNUOI7WI-bcnSAWDAZnYG1VsU_pAlLr9vnYo59SiZ600yD0DiKyHpedLgRb8PWUVgefo4PE61HcZQkCxwvook5oxHw-YGXZtM" style="border:none" width="134" height="200"></span></p></td><td style="border-left:1.5pt solid rgb(32,195,212);vertical-align:top;padding:5pt"><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><span style="font-size:11pt;color:rgb(32,195,212);font-weight:700"><font face="georgia, serif">Megan Baptista</font></span></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><span style="font-size:11pt;color:rgb(0,0,0)"><font face="georgia, serif">Owner, My TC Concierge</font></span></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><font face="georgia, serif"><span style="font-size:11pt;color:rgb(0,0,0)">DRE#01956910</span></font></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><span style="font-family:georgia,serif">@My.TC.Concierge</span></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><a href="http://www.mytcconcierge.com" target="_blank"><span style="font-size:11pt;color:rgb(255,98,228)"><font face="georgia, serif">MyTcConcierge.com</font></span></a></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt"><br></p><p dir="ltr" style="line-height:1.2;margin:0pt 0pt 0pt 4.5pt">Office Hours Mon - Fri 8am - 5pm PST</p></td></tr></tbody></table></div></div>';

/** Append the signature to an HTML body. */
function withSignature(htmlBody) {
  return `${htmlBody}\n${SIGNATURE_HTML}`;
}

module.exports = { SIGNATURE_HTML, withSignature };

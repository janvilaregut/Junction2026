/* The Katse goat: an SVG rig with 12 animated states. Self-contained (it injects its own CSS once) so the
   mascot can be swapped by replacing this file. createGoat(state) returns an <svg> string;
   setGoatState(svg, state) switches; svg.style --lx/--ly (−1..1) drive the 2.5D look-at, --amp (0..1) the lip-sync.
   Fixes over the original kit: the eyelid no longer covers the eyes in states without blinking, the mouth follows
   real audio amplitude while talking, and every pivot is wrapped so transforms never drift. */

export const STATES = ['idle', 'talking', 'bleating', 'happy', 'thinking', 'listening', 'surprised', 'love', 'confused', 'angry', 'sad', 'sleeping'];

const CSS = `
.goat-svg{--lx:0;--ly:0;--amp:0;overflow:visible}
.goat-svg [class^="anim-"],.goat-svg [class*=" anim-"]{transform-origin:0 0}
.goat-svg .px-root{transform:rotate(calc(var(--lx)*3.5deg))}
.goat-svg .px-horns{transform:translate(calc(var(--lx)*-7px),calc(var(--ly)*-5px))}
.goat-svg .px-ears{transform:translate(calc(var(--lx)*-5px),calc(var(--ly)*-3px))}
.goat-svg .px-tuft{transform:translate(calc(var(--lx)*8px),calc(var(--ly)*4px))}
.goat-svg .px-beard{transform:translate(calc(var(--lx)*9px),calc(var(--ly)*4px))}
.goat-svg .px-face{transform:translate(calc(var(--lx)*15px),calc(var(--ly)*11px))}
.goat-svg .px-pupils{transform:translate(calc(var(--lx)*15px),calc(var(--ly)*12px))}
.goat-svg .mouth-open,.goat-svg .mouth-smile,.goat-svg .mouth-omega,.goat-svg .mouth-wavy,.goat-svg .mouth-frown,
.goat-svg .eyes-happy,.goat-svg .eyes-sleep,.goat-svg .brows-angry,.goat-svg .brows-sad,.goat-svg .cheeks,
.goat-svg .pupils-heart,.goat-svg .tear-drop,.goat-svg .sleep-bubble,.goat-svg .prop-group{display:none}
/* FIX: the eyelid is closed only while a blink animation runs */
.goat-svg .anim-blink{transform:scaleY(0)}
@keyframes gBlink{0%,90%,96%,100%{transform:scaleY(0)}93%{transform:scaleY(1)}}
@keyframes gBlink2{0%,74%,80%,86%,100%{transform:scaleY(0)}77%,83%{transform:scaleY(1)}}

.state-idle .anim-root{animation:gIdleBreath 3.2s ease-in-out infinite}
.state-idle .anim-ear-l{animation:gIdleEarL 3.2s ease-in-out infinite}
.state-idle .anim-ear-r{animation:gIdleEarR 3.2s ease-in-out infinite}
.state-idle .anim-tuft{animation:gIdleTuft 3.2s ease-in-out -.2s infinite}
.state-idle .anim-beard{animation:gIdleTuft 3.2s ease-in-out -.3s infinite}
.state-idle .anim-blink{animation:gBlink2 5.2s ease-in-out infinite}
.state-idle:not(.tracking) .anim-pupils{animation:gLook 6.5s ease-in-out infinite}
@keyframes gIdleBreath{0%,100%{transform:scale(1,1)}50%{transform:scale(1.028,.972)}}
@keyframes gIdleEarL{0%,100%{transform:rotate(0)}45%{transform:rotate(-5deg)}52%{transform:rotate(4deg)}60%{transform:rotate(-2deg)}}
@keyframes gIdleEarR{0%,100%{transform:rotate(0)}50%{transform:rotate(5deg)}}
@keyframes gIdleTuft{0%,100%{transform:rotate(0) translateY(0)}50%{transform:rotate(2.5deg) translateY(2px)}}
@keyframes gLook{0%,28%,100%{transform:translate(0,0)}35%,55%{transform:translate(-12px,2px)}65%,85%{transform:translate(13px,-3px)}}

.state-talking .mouth-oval{display:none}.state-talking .mouth-open{display:block}
.state-talking .anim-mouth{transform:scale(calc(.32 + var(--amp)*.85),calc(.22 + var(--amp)*1.05));transition:transform 60ms linear}
.state-talking .anim-root{animation:gTalkBounce .9s ease-in-out infinite}
.state-talking .anim-ear-l{animation:gTalkEarL .9s ease-in-out infinite}
.state-talking .anim-ear-r{animation:gTalkEarR .9s ease-in-out infinite}
.state-talking .anim-tuft{animation:gTalkTuft .9s ease-in-out -.1s infinite}
.state-talking .anim-beard{transform:translateY(calc(var(--amp)*7px)) scaleY(calc(.94 + var(--amp)*.16));transition:transform 60ms linear}
.state-talking .anim-blink{animation:gBlink 3.6s ease-in-out infinite}
@keyframes gTalkBounce{0%,100%{transform:scale(1.015,.985) rotate(-.8deg)}50%{transform:scale(.99,1.015) translateY(-4px) rotate(.8deg)}}
@keyframes gTalkEarL{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(6deg)}}
@keyframes gTalkEarR{0%,100%{transform:rotate(3deg)}50%{transform:rotate(-6deg)}}
@keyframes gTalkTuft{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(4deg)}}

.state-bleating .mouth-oval{display:none}.state-bleating .mouth-open,.state-bleating .prop-bleat{display:block}
.state-bleating .anim-root{animation:gBleatBody .14s linear infinite alternate}
.state-bleating .anim-mouth{animation:gBleatMouth .12s ease-in-out infinite alternate}
.state-bleating .anim-tongue{animation:gBleatTongue .11s ease-in-out infinite alternate}
.state-bleating .anim-ear-l{animation:gBleatEarL .13s ease-in-out infinite alternate}
.state-bleating .anim-ear-r{animation:gBleatEarR .13s ease-in-out infinite alternate}
.state-bleating .anim-beard{animation:gBleatBeard .1s linear infinite alternate}
.state-bleating .anim-prop{animation:gWaves .4s ease-out infinite}
@keyframes gBleatBody{from{transform:translate(-2px,-8px) scale(.97,1.05) rotate(-1.5deg)}to{transform:translate(2px,-11px) scale(.98,1.06) rotate(1.5deg)}}
@keyframes gBleatMouth{from{transform:scale(.95,1.25)}to{transform:scale(1.12,1.42)}}
@keyframes gBleatTongue{from{transform:translateX(-6px)}to{transform:translateX(6px)}}
@keyframes gBleatEarL{from{transform:rotate(8deg)}to{transform:rotate(18deg)}}
@keyframes gBleatEarR{from{transform:rotate(-8deg)}to{transform:rotate(-18deg)}}
@keyframes gBleatBeard{from{transform:rotate(-6deg) translateY(4px)}to{transform:rotate(6deg) translateY(6px)}}
@keyframes gWaves{0%{transform:scale(.85);opacity:.95}100%{transform:scale(1.18);opacity:0}}

.state-happy .eyes-normal{display:none}.state-happy .eyes-happy,.state-happy .cheeks,.state-happy .mouth-open,.state-happy .prop-happy{display:block}.state-happy .mouth-oval{display:none}
.state-happy .anim-root{animation:gJump 1.1s cubic-bezier(.28,.84,.42,1) infinite}
.state-happy .anim-ear-l{animation:gHapEarL 1.1s ease-in-out infinite}
.state-happy .anim-ear-r{animation:gHapEarR 1.1s ease-in-out infinite}
.state-happy .anim-beard{animation:gHapBeard 1.1s ease-in-out infinite}
.state-happy .anim-mouth{animation:gHapMouth 1.1s ease-in-out infinite}
.state-happy .anim-prop{animation:gSparkle 1.1s ease-in-out infinite}
@keyframes gJump{0%,100%{transform:translateY(0) scale(1.08,.91)}15%{transform:scale(1.12,.87)}45%{transform:translateY(-42px) scale(.94,1.07) rotate(2deg)}75%{transform:translateY(0) scale(1.09,.9) rotate(-1deg)}88%{transform:translateY(-6px)}}
@keyframes gHapEarL{0%,15%,100%{transform:rotate(-14deg)}45%{transform:rotate(22deg)}75%{transform:rotate(-18deg)}}
@keyframes gHapEarR{0%,15%,100%{transform:rotate(14deg)}45%{transform:rotate(-22deg)}75%{transform:rotate(18deg)}}
@keyframes gHapBeard{0%,100%{transform:scaleY(.88)}50%{transform:translateY(8px) scaleY(1.15)}}
@keyframes gHapMouth{0%,100%{transform:scale(1,.85)}45%{transform:scale(1.12,1.08)}}
@keyframes gSparkle{0%,100%{transform:scale(.5);opacity:.3}45%{transform:scale(1.15) rotate(20deg);opacity:1}}

.state-thinking .prop-thinking{display:block}
.state-thinking .anim-root{animation:gThinkSway 3.4s ease-in-out infinite}
.state-thinking .anim-ear-l{animation:gThinkEarL 3.4s ease-in-out infinite}
.state-thinking .anim-ear-r{animation:gThinkEarR 1.7s ease-in-out infinite}
.state-thinking .anim-pupils{animation:gThinkLook 3.4s ease-in-out infinite}
.state-thinking .anim-mouth{animation:gThinkMouth 2.2s ease-in-out infinite}
.state-thinking .anim-blink{animation:gBlink 4.2s ease-in-out infinite}
.state-thinking .dot-1{animation:gDot 1.2s ease-in-out 0s infinite}.state-thinking .dot-2{animation:gDot 1.2s ease-in-out .2s infinite}.state-thinking .dot-3{animation:gDot 1.2s ease-in-out .4s infinite}
@keyframes gThinkSway{0%,100%{transform:rotate(-3.5deg) scale(1.01,.99)}50%{transform:rotate(1.5deg) scale(.99,1.01)}}
@keyframes gThinkEarL{0%,100%{transform:rotate(-14deg)}50%{transform:rotate(-8deg)}}
@keyframes gThinkEarR{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(-28deg)}}
@keyframes gThinkLook{0%,100%{transform:translate(15px,-14px)}50%{transform:translate(8px,-17px)}}
@keyframes gThinkMouth{0%,100%{transform:translate(-14px,-2px) scale(.82,.65)}50%{transform:translate(10px,0) scale(.75,.75)}}
@keyframes gDot{0%,70%,100%{transform:translateY(0);opacity:.45}35%{transform:translateY(-7px);opacity:1}}

.state-listening .mouth-oval{display:none}.state-listening .mouth-smile,.state-listening .prop-listening{display:block}
.state-listening .anim-root{animation:gListenLean 2.2s ease-in-out infinite}
.state-listening .anim-ear-l{animation:gCupEar 1.1s ease-in-out infinite}
.state-listening .anim-ear-r{transform:rotate(6deg)}
.state-listening .anim-pupils{animation:gListenEyes 2.2s ease-in-out infinite}
.state-listening .anim-blink{animation:gBlink 4s ease-in-out infinite}
.state-listening .wave-1{animation:gSound 1.4s ease-out 0s infinite}.state-listening .wave-2{animation:gSound 1.4s ease-out .35s infinite}.state-listening .wave-3{animation:gSound 1.4s ease-out .7s infinite}
@keyframes gListenLean{0%,100%{transform:scale(1.02) rotate(-3deg)}50%{transform:scale(1.045) translateY(-4px) rotate(-5deg)}}
@keyframes gCupEar{0%,100%{transform:rotate(16deg) scale(1.12)}50%{transform:rotate(25deg) scale(1.18)}}
@keyframes gListenEyes{0%,100%{transform:translate(-15px,-2px)}50%{transform:translate(-18px,-5px)}}
@keyframes gSound{0%{opacity:0;transform:translateX(-14px) scale(.85)}40%{opacity:1}100%{opacity:0;transform:translateX(8px) scale(1.08)}}

.state-surprised .prop-surprised{display:block}
.state-surprised .anim-root{animation:gShock 2.2s cubic-bezier(.22,1,.36,1) infinite}
.state-surprised .anim-eye-l,.state-surprised .anim-eye-r{animation:gShockEyes 2.2s ease-out infinite}
.state-surprised .anim-pupil-l,.state-surprised .anim-pupil-r{animation:gShockPupils .12s linear infinite alternate}
.state-surprised .anim-mouth{animation:gShockMouth 2.2s ease-out infinite}
.state-surprised .anim-prop{animation:gExclaim 2.2s ease-out infinite}
@keyframes gShock{0%,100%{transform:scale(1)}8%{transform:scale(1.12,.86)}20%{transform:translateY(-30px) scale(.91,1.12)}58%{transform:translateY(0) scale(1.04,.96)}75%{transform:scale(1)}}
@keyframes gShockEyes{0%,8%,80%,100%{transform:scale(1)}20%,45%{transform:scale(1.13)}}
@keyframes gShockPupils{from{transform:scale(.46) translate(-2px,4px)}to{transform:scale(.46) translate(2px,2px)}}
@keyframes gShockMouth{0%,8%,80%,100%{transform:scale(1)}20%,48%{transform:scale(1.9,1.95) translateY(3px)}}
@keyframes gExclaim{0%,12%,75%,100%{transform:scale(0) translateY(20px);opacity:0}22%,50%{transform:scale(1.08);opacity:1}65%{transform:scale(.9) translateY(-6px);opacity:0}}

.state-love .pupils-round,.state-love .mouth-oval{display:none}.state-love .pupils-heart,.state-love .cheeks,.state-love .mouth-omega,.state-love .prop-love{display:block}
.state-love .anim-root{animation:gLoveSway 2.6s ease-in-out infinite}
.state-love .anim-pupil-l,.state-love .anim-pupil-r{animation:gHeartBeat .86s ease-in-out infinite}
.state-love .heart-float-1{animation:gFloatHeart 2.4s ease-out 0s infinite}.state-love .heart-float-2{animation:gFloatHeart 2.4s ease-out 1.2s infinite}
.state-love .anim-blink{animation:gBlink 4s ease-in-out infinite}
@keyframes gLoveSway{0%,100%{transform:rotate(-4.5deg) scale(1.02,.98)}50%{transform:rotate(4.5deg) scale(1.02,.98)}}
@keyframes gHeartBeat{0%,100%{transform:scale(.92)}35%{transform:scale(1.22)}55%{transform:scale(1.02)}75%{transform:scale(1.16)}}
@keyframes gFloatHeart{0%{transform:translateY(15px) scale(.4);opacity:0}25%{opacity:1}100%{transform:translateY(-48px) scale(1.08) rotate(12deg);opacity:0}}

.state-confused .mouth-oval{display:none}.state-confused .mouth-wavy,.state-confused .prop-confused{display:block}
.state-confused .anim-root{animation:gTilt 3.2s ease-in-out infinite}
.state-confused .anim-eye-l{transform:scale(1.14)}.state-confused .anim-eye-r{transform:scale(.84)}
.state-confused .anim-pupil-l{animation:gConfL 3.2s ease-in-out infinite}.state-confused .anim-pupil-r{animation:gConfR 3.2s ease-in-out infinite}
.state-confused .anim-ear-l{animation:gConfEarL 3.2s ease-in-out infinite}.state-confused .anim-ear-r{animation:gConfEarR 3.2s ease-in-out infinite}
.state-confused .anim-prop{animation:gQBob 1.6s ease-in-out infinite}
.state-confused .anim-blink{animation:gBlink 4.6s ease-in-out infinite}
@keyframes gTilt{0%,100%{transform:rotate(-9deg) translateY(4px)}50%{transform:rotate(7deg) translateY(2px)}}
@keyframes gConfL{0%,100%{transform:scale(.75) translate(-6px,-6px)}50%{transform:scale(.75) translate(6px,4px)}}
@keyframes gConfR{0%,100%{transform:scale(1.15) translate(5px,6px)}50%{transform:scale(1.15) translate(-5px,-4px)}}
@keyframes gConfEarL{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(18deg)}}
@keyframes gConfEarR{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(22deg)}}
@keyframes gQBob{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-10px) rotate(10deg)}}

.state-angry .brows-angry,.state-angry .mouth-frown,.state-angry .prop-angry{display:block}.state-angry .mouth-oval{display:none}
.state-angry .anim-root{animation:gStomp 1.6s ease-in-out infinite}
.state-angry .anim-ear-l{transform:rotate(-20deg)}.state-angry .anim-ear-r{transform:rotate(20deg)}
.state-angry .anim-pupil-l{transform:translate(7px,5px) scale(.88)}.state-angry .anim-pupil-r{transform:translate(-7px,6px) scale(.88)}
.state-angry .puff-l{animation:gPuffL 1.6s ease-out infinite}.state-angry .puff-r{animation:gPuffR 1.6s ease-out infinite}
@keyframes gStomp{0%,100%{transform:scale(1.06,.93)}15%{transform:scale(1.09,.9) translateX(-4px)}22%{transform:scale(1.09,.9) translateX(4px)}29%{transform:scale(1.09,.9) translateX(-4px)}36%{transform:scale(1.09,.9) translateX(4px)}55%{transform:scale(1.03,.96)}}
@keyframes gPuffL{0%,15%{transform:translate(15px,10px) scale(.3);opacity:0}35%{opacity:1}85%,100%{transform:translate(-28px,-22px) scale(1.15);opacity:0}}
@keyframes gPuffR{0%,15%{transform:translate(-15px,10px) scale(.3);opacity:0}35%{opacity:1}85%,100%{transform:translate(28px,-22px) scale(1.15);opacity:0}}

.state-sad .brows-sad,.state-sad .mouth-frown{display:block}.state-sad .mouth-oval{display:none}
.state-sad .tear-drop{display:block;animation:gTear 2.4s ease-in infinite}
.state-sad .anim-root{animation:gSigh 3.2s ease-in-out infinite}
.state-sad .anim-ear-l{animation:gSadEarL 3.2s ease-in-out infinite}.state-sad .anim-ear-r{animation:gSadEarR 3.2s ease-in-out infinite}
.state-sad .anim-tuft{transform:rotate(8deg) translateY(5px)}
.state-sad .anim-pupils{animation:gSadWob .22s ease-in-out infinite alternate}
@keyframes gSigh{0%,100%{transform:scale(1.05,.91) translateY(6px)}45%{transform:scale(1.02,.95)}}
@keyframes gSadEarL{0%,100%{transform:rotate(-32deg)}45%{transform:rotate(-25deg)}}
@keyframes gSadEarR{0%,100%{transform:rotate(32deg)}45%{transform:rotate(25deg)}}
@keyframes gSadWob{from{transform:translate(-1px,10px) scale(1.1)}to{transform:translate(1px,11px) scale(1.12)}}
@keyframes gTear{0%{transform:translateY(0) scale(.4);opacity:0}20%{transform:translateY(4px) scale(1);opacity:1}85%{opacity:1}100%{transform:translateY(58px) scale(.85);opacity:0}}

.state-sleeping .eyes-normal{display:none}.state-sleeping .eyes-sleep,.state-sleeping .prop-sleeping{display:block}
.state-sleeping .sleep-bubble{display:block;animation:gBubble 3.8s ease-in-out infinite}
.state-sleeping .anim-root{animation:gSleepBreath 3.8s ease-in-out infinite}
.state-sleeping .anim-ear-l{animation:gSleepEarL 3.8s ease-in-out infinite}.state-sleeping .anim-ear-r{animation:gSleepEarR 3.8s ease-in-out infinite}
.state-sleeping .zzz-1{animation:gZzz 3.6s linear 0s infinite}.state-sleeping .zzz-2{animation:gZzz 3.6s linear 1.2s infinite}.state-sleeping .zzz-3{animation:gZzz 3.6s linear 2.4s infinite}
@keyframes gSleepBreath{0%,100%{transform:scale(1.05,.93)}50%{transform:scale(.98,1.02)}}
@keyframes gSleepEarL{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(-14deg)}}
@keyframes gSleepEarR{0%,100%{transform:rotate(22deg)}50%{transform:rotate(14deg)}}
@keyframes gBubble{0%,100%{transform:scale(.35);opacity:.75}50%{transform:scale(1.18);opacity:.95}}
@keyframes gZzz{0%{transform:translate(0,10px) scale(.5);opacity:0}20%{opacity:1}80%{opacity:.9}100%{transform:translate(38px,-65px) scale(1.15) rotate(10deg);opacity:0}}
@media (prefers-reduced-motion:reduce){.goat-svg *{animation-duration:0s!important;animation-iteration-count:1!important}}
`;

const pivot = (x, y, cls, content) => `<g transform="translate(${x},${y})"><g class="${cls}"><g transform="translate(${-x},${-y})">${content}</g></g></g>`;

const GEO = {
  hornL: 'M 338,148 C 322,72 250,46 190,82 C 170,94 176,123 196,117 C 229,107 262,122 280,168 Z',
  hornR: 'M 482,145 C 498,68 570,42 630,78 C 650,90 644,119 624,113 C 591,103 558,120 540,165 Z',
  body: 'M 225,190 C 275,118 365,114 420,114 C 485,114 552,127 600,195 Q 650,266 700,337 C 728,377 726,455 665,502 C 617,539 565,542 505,542 L 315,542 C 255,542 203,539 155,502 C 94,455 97,377.5 122,340 Q 172,265 225,190 Z',
  earL: 'M 250,200 C 190,184 126,192 98,220 C 84,234 94,258 118,259 C 158,261 200,250 235,236 Z',
  earR: 'M 572,195 C 632,178 696,186 724,214 C 738,228 728,252 704,253 C 664,255 622,244 587,231 Z',
  inEarL: 'M 206,215 C 174,207 138,213 122,228 C 115,235 121,245 134,246 C 160,247 186,240 205,231 Z',
  inEarR: 'M 616,209 C 648,201 684,207 700,222 C 707,229 701,239 688,240 C 662,241 636,234 617,225 Z',
  tuft: '<circle cx="376" cy="108" r="26"/><path d="M 383,115 L 419,69 A 24 24 0 0 1 457,99 L 421,145 A 24 24 0 0 1 383,115 Z"/><circle cx="452" cy="112" r="23"/>',
  beard: '<circle cx="395" cy="547" r="20"/><ellipse cx="424" cy="554" rx="21" ry="26"/><circle cx="453" cy="546" r="19"/>',
  heart: 'M 0,17 C -4,13 -22,2 -22,-9 C -22,-19 -13,-23 -5,-18 C -2,-16 0,-13 0,-13 C 0,-13 2,-16 5,-18 C 13,-23 22,-19 22,-9 C 22,2 4,13 0,17 Z',
};
const C = { body: '#DE8352', inner: '#B56237', horn: '#47332A', ink: '#182C25' };

export function injectGoatCSS() {
  if (document.getElementById('goat-css')) return;
  const s = document.createElement('style');
  s.id = 'goat-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGoat(state = 'idle', uid = 'g') {
  const clip = `goat-mouth-${uid}`;
  const horns = (o) => `<g class="px-horns">${pivot(310, 158, 'anim-horn-l', `<path ${o ? '' : `fill="${C.horn}"`} d="${GEO.hornL}"/>`)}${pivot(510, 155, 'anim-horn-r', `<path ${o ? '' : `fill="${C.horn}"`} d="${GEO.hornR}"/>`)}</g>`;
  const ears = (o) => `<g class="px-ears">${pivot(235, 218, 'anim-ear-l', o ? `<path d="${GEO.earL}"/>` : `<path fill="${C.body}" d="${GEO.earL}"/><path fill="${C.inner}" d="${GEO.inEarL}"/>`)}${pivot(585, 213, 'anim-ear-r', o ? `<path d="${GEO.earR}"/>` : `<path fill="${C.body}" d="${GEO.earR}"/><path fill="${C.inner}" d="${GEO.inEarR}"/>`)}</g>`;
  const tuft = (o) => `<g class="px-tuft">${pivot(415, 132, 'anim-tuft', `<g ${o ? '' : `fill="${C.body}"`}>${GEO.tuft}</g>`)}</g>`;
  const beard = (o) => `<g class="px-beard">${pivot(424, 542, 'anim-beard', `<g ${o ? '' : `fill="${C.body}"`}>${GEO.beard}</g>`)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 740" class="goat-svg state-${state}" aria-hidden="true">
<defs><clipPath id="${clip}"><path d="M 392,424 C 410,430 440,430 458,424 C 462,469 388,469 392,424 Z"/></clipPath></defs>
<g transform="translate(10,78)"><g transform="translate(415,542)"><g class="px-root"><g class="anim-root"><g transform="translate(-415,-542)">
<g fill="#FFFFFF" stroke="#FFFFFF" stroke-width="32" stroke-linejoin="round" stroke-linecap="round">${horns(true)}${ears(true)}<path d="${GEO.body}"/>${tuft(true)}${beard(true)}</g>
<g>${horns(false)}${ears(false)}<path fill="${C.body}" d="${GEO.body}"/>${tuft(false)}${beard(false)}</g>
<g class="px-face">
 <g class="cheeks"><ellipse cx="308" cy="422" rx="25" ry="14" fill="#F0554A" opacity=".55" transform="rotate(-6 308 422)"/><ellipse cx="536" cy="410" rx="25" ry="14" fill="#F0554A" opacity=".55" transform="rotate(-6 536 410)"/></g>
 <g class="eyes-normal">
  ${pivot(374, 388, 'anim-eye-l', '<circle cx="374" cy="388" r="49" fill="#FFFFFF"/>')}
  ${pivot(470, 377, 'anim-eye-r', '<circle cx="470" cy="377" r="49" fill="#FFFFFF"/>')}
  <g class="px-pupils">${pivot(424, 372, 'anim-pupils', `
   <g class="pupils-round">${pivot(378, 378, 'anim-pupil-l', '<circle cx="378" cy="378" r="21" fill="#050505"/>')}${pivot(469, 365, 'anim-pupil-r', '<circle cx="469" cy="365" r="21" fill="#050505"/>')}</g>
   <g class="pupils-heart"><g transform="translate(378,382)"><g class="anim-pupil-l"><path fill="#E63946" d="${GEO.heart}"/></g></g><g transform="translate(468,371)"><g class="anim-pupil-r"><path fill="#E63946" d="${GEO.heart}"/></g></g></g>`)}</g>
  <path class="brows-angry" fill="${C.body}" d="M 312,312 L 532,302 L 532,350 L 423,390 L 312,360 Z"/>
  <g class="brows-sad" fill="${C.body}"><path d="M 314,318 L 414,318 L 414,342 L 314,388 Z"/><path d="M 430,308 L 530,308 L 530,378 L 430,332 Z"/></g>
  ${pivot(422, 320, 'anim-blink', `<rect x="312" y="318" width="220" height="132" fill="${C.body}"/>`)}
 </g>
 <g class="eyes-happy" fill="none" stroke="${C.ink}" stroke-width="13" stroke-linecap="round"><path d="M 342,395 C 352,360 396,360 406,395"/><path d="M 438,384 C 448,349 492,349 502,384"/></g>
 <g class="eyes-sleep" fill="none" stroke="${C.ink}" stroke-width="12" stroke-linecap="round"><path d="M 342,384 C 354,412 394,412 406,384"/><path d="M 438,373 C 450,401 490,401 502,373"/></g>
 <g transform="translate(335,416)"><g class="tear-drop"><path fill="#63CBE8" d="M 0,-14 C 6,-4 12,4 12,11 A 12 12 0 1 1 -12,11 C -12,4 -6,-4 0,-14 Z"/><circle cx="-4" cy="10" r="3.5" fill="#FFFFFF" opacity=".8"/></g></g>
 ${pivot(425, 436, 'anim-mouth', `
  <ellipse class="mouth-oval" cx="425" cy="435" rx="9" ry="13.5" fill="${C.ink}"/>
  <g class="mouth-open"><path fill="${C.ink}" d="M 392,424 C 410,430 440,430 458,424 C 462,469 388,469 392,424 Z"/><g clip-path="url(#${clip})">${pivot(425, 460, 'anim-tongue', '<ellipse cx="425" cy="460" rx="22" ry="16" fill="#F26D6D"/>')}</g></g>
  <path class="mouth-smile" d="M 408,432 C 415,447 435,447 442,432" fill="none" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>
  <path class="mouth-omega" d="M 401,431 C 405,446 421,446 425,433 C 429,446 445,446 449,431" fill="none" stroke="${C.ink}" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="mouth-wavy" d="M 401,439 C 412,426 422,448 433,434 C 439,427 445,436 449,440" fill="none" stroke="${C.ink}" stroke-width="8.5" stroke-linecap="round"/>
  <path class="mouth-frown" d="M 406,446 C 414,430 436,430 444,446" fill="none" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>`)}
 <g transform="translate(448,424)"><g class="sleep-bubble"><circle cx="18" cy="-12" r="24" fill="#B3DCE2" opacity=".85" stroke="#FFFFFF" stroke-width="4"/><circle cx="10" cy="-20" r="6" fill="#FFFFFF"/></g></g>
</g>
</g></g></g></g>
<g class="prop-group prop-bleat">${pivot(425, 360, 'anim-prop', '<g fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"><path d="M 68,310 Q 44,355 68,400"/><path d="M 42,290 Q 10,355 42,420"/><path d="M 752,310 Q 776,355 752,400"/><path d="M 778,290 Q 810,355 778,420"/></g>')}</g>
<g class="prop-group prop-happy">${pivot(132, 118, 'anim-prop', '<path d="M 132,88 Q 132,118 162,118 Q 132,118 132,148 Q 132,118 102,118 Q 132,118 132,88 Z" fill="#FFBE3B" stroke="#FFFFFF" stroke-width="10" stroke-linejoin="round"/>')}${pivot(692, 108, 'anim-prop', '<path d="M 692,82 Q 692,108 718,108 Q 692,108 692,134 Q 692,108 666,108 Q 692,108 692,82 Z" fill="#FFBE3B" stroke="#FFFFFF" stroke-width="10" stroke-linejoin="round"/>')}</g>
<g class="prop-group prop-thinking"><circle cx="595" cy="95" r="10" fill="#FFFFFF"/><circle cx="622" cy="68" r="15" fill="#FFFFFF"/><rect x="635" y="0" width="128" height="64" rx="32" fill="#FFFFFF"/><circle class="dot-1" cx="672" cy="32" r="8" fill="${C.horn}"/><circle class="dot-2" cx="699" cy="32" r="8" fill="${C.horn}"/><circle class="dot-3" cx="726" cy="32" r="8" fill="${C.horn}"/></g>
<g class="prop-group prop-listening" fill="none" stroke="#e3dcf4" stroke-width="10" stroke-linecap="round"><g transform="translate(75,225)"><g class="wave-1"><path d="M 0,-22 Q -18,0 0,22"/></g></g><g transform="translate(52,225)"><g class="wave-2"><path d="M 0,-36 Q -28,0 0,36"/></g></g><g transform="translate(28,225)"><g class="wave-3"><path d="M 0,-50 Q -38,0 0,50"/></g></g></g>
<g class="prop-group prop-surprised">${pivot(418, 22, 'anim-prop', '<g stroke="#FFFFFF" stroke-width="16" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke fill"><path d="M 410,-36 L 426,-36 L 423,12 L 413,12 Z" fill="#F0554A"/><circle cx="418" cy="34" r="9" fill="#F0554A"/></g>')}</g>
<g class="prop-group prop-love"><g transform="translate(150,115)"><g class="heart-float-1"><path d="${GEO.heart}" fill="#F0554A" stroke="#FFFFFF" stroke-width="10" paint-order="stroke fill" transform="scale(1.3)"/></g></g><g transform="translate(675,105)"><g class="heart-float-2"><path d="${GEO.heart}" fill="#F0554A" stroke="#FFFFFF" stroke-width="10" paint-order="stroke fill" transform="scale(1.2)"/></g></g></g>
<g class="prop-group prop-confused">${pivot(655, 36, 'anim-prop', '<path d="M 636,-4 C 636,-24 674,-24 674,-2 C 674,12 655,14 655,28" fill="none" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round"/><path d="M 636,-4 C 636,-24 674,-24 674,-2 C 674,12 655,14 655,28" fill="none" stroke="#F59E0B" stroke-width="11" stroke-linecap="round"/><circle cx="655" cy="50" r="7.5" fill="#F59E0B" stroke="#FFFFFF" stroke-width="8" paint-order="stroke fill"/>')}</g>
<g class="prop-group prop-angry" fill="#FFFFFF"><g transform="translate(155,115)"><g class="puff-l"><circle r="16"/><circle cx="-16" cy="-6" r="13"/><circle cx="-8" cy="12" r="11"/></g></g><g transform="translate(665,110)"><g class="puff-r"><circle r="16"/><circle cx="16" cy="-6" r="13"/><circle cx="8" cy="12" r="11"/></g></g></g>
<g class="prop-group prop-sleeping" font-family="Outfit, system-ui, sans-serif" font-weight="800" fill="#cde4ee" stroke="#FFFFFF" stroke-width="8" stroke-linejoin="round" paint-order="stroke fill"><g transform="translate(555,95)"><g class="zzz-1"><text font-size="38">Z</text></g></g><g transform="translate(575,90)"><g class="zzz-2"><text font-size="30">z</text></g></g><g transform="translate(590,85)"><g class="zzz-3"><text font-size="24">z</text></g></g></g>
</g></svg>`;
}

export function setGoatState(svg, state) {
  for (const s of STATES) svg.classList.remove(`state-${s}`);
  svg.classList.add(`state-${STATES.includes(state) ? state : 'idle'}`);
}

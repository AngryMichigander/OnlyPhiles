const fs = require('fs');
const path = require('path');

const VALID_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','GU','VI','AS','MP',
  'PH','RU','MX','UK','US','NW','MR','MF','EV'
]);

const CRIME_CLASSIFIERS = [
  { types: ['csam'], patterns: [/child sexual abuse material/i, /\bcsam\b/i, /child porn/i, /child sex abuse material/i, /sexual exploitation of a (minor|child)/i, /child sexual exploitation/i, /sexual exploitation material/i] },
  { types: ['rape'], patterns: [/\brape\b/i, /sexual battery/i] },
  { types: ['child-molestation'], patterns: [/child molest/i, /molest(ing|ation) of (a )?(child|minor)/i] },
  { types: ['statutory-rape'], patterns: [/statutory rape/i, /rape of a minor/i, /sex(ual)? (with|of) (a )?minor/i, /sex(ual)? (with|of) (an? )?(underage|child)/i, /carnal knowledge/i] },
  { types: ['assault'], patterns: [/sexual assault/i, /sex(ual)? abuse/i, /felony sex abuse/i, /indecent assault/i, /sexual battery/i, /criminal sexual conduct/i] },
  { types: ['trafficking'], patterns: [/trafficking/i] },
  { types: ['solicitation'], patterns: [/solicit/i, /luring/i, /enticement/i, /online predator/i] },
  { types: ['grooming'], patterns: [/groom/i, /inappropriate (relationship|contact|communication)/i, /sexting.*minor/i] },
  { types: ['enablement'], patterns: [/enabl/i, /cover[- ]?up/i, /defending child/i, /organizational cover/i, /obstruct/i] },
  { types: ['organizational-coverup'], patterns: [/organizational cover/i, /cover[- ]?up/i] },
  { types: ['domestic-violence'], patterns: [/domestic violen/i, /domestic abuse/i, /spousal/i] },
  { types: ['murder'], patterns: [/murder/i, /homicide/i, /manslaughter/i] },
  { types: ['harassment'], patterns: [/harassment/i, /rape culture/i] },
  { types: ['indecent-exposure'], patterns: [/indecent exposure/i, /voyeurism/i, /exhibitionism/i, /public (indecency|lewdness)/i] },
  { types: ['incest'], patterns: [/incest/i] },
  { types: ['stalking'], patterns: [/stalk/i] },
];

function classifyCrime(desc) {
  const types = new Set();
  for (const { types: crimeTypes, patterns } of CRIME_CLASSIFIERS) {
    for (const pattern of patterns) {
      if (pattern.test(desc)) {
        crimeTypes.forEach(t => types.add(t));
        break;
      }
    }
  }
  if (types.size === 0) types.add('other');
  return [...types];
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseLine(line) {
  line = line.replace(/&nbsp;/g, '').replace(/\s+/g, ' ').trim();
  line = line.replace(/([A-Z]{2})\/([A-Z]{2})(?=[A-Z])/, '$1');
  line = line.replace('HaggardClO', 'HaggardCO');
  if (!line) return null;

  const numMatch = line.match(/^(\d+)/);
  if (!numMatch) return null;

  const number = parseInt(numMatch[1]);
  const rest = line.slice(numMatch[0].length);

  let bestSplit = null;
  for (let i = 1; i < rest.length - 2; i++) {
    const charBefore = rest[i - 1];
    const candidate = rest.slice(i, i + 2);
    const afterState = rest.slice(i + 2).trim();

    if (!/^[A-Z]{2}$/.test(candidate)) continue;
    if (!VALID_STATES.has(candidate)) continue;

    const validBoundary = /[a-z.,) I]/.test(charBefore);
    if (!validBoundary) continue;

    const beforeState = rest.slice(0, i);
    if (afterState.length > 0 && /^[A-Z]/.test(afterState) && beforeState.trim().length > 0) {
      bestSplit = {
        name: beforeState.trim(),
        state: candidate,
        crimeDescription: afterState
      };
      break;
    }
  }

  if (!bestSplit) {
    console.error(`Could not parse line: ${line}`);
    return null;
  }

  const { name, state, crimeDescription } = bestSplit;
  const crimeTypes = classifyCrime(crimeDescription);
  const id = slugify(name);

  return { id, number, name, state, crimeDescription, crimeTypes };
}

// Main
const inputPath = path.join(__dirname, '..', 'data', 'goppredators-full.txt');
const outputPath = path.join(__dirname, '..', 'data', 'goppredators-parsed.json');

const lines = fs.readFileSync(inputPath, 'utf-8').split('\n').filter(l => l.trim());
const parsed = [];
const errors = [];

for (const line of lines) {
  const entry = parseLine(line);
  if (entry) {
    parsed.push(entry);
  } else if (line.trim()) {
    errors.push(line);
  }
}

parsed.sort((a, b) => b.number - a.number);

fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2));
console.log(`Parsed ${parsed.length} entries, ${errors.length} errors`);
if (errors.length > 0) {
  console.log('Errors:', errors);
}

// Print crime type distribution
const typeCounts = {};
for (const entry of parsed) {
  for (const t of entry.crimeTypes) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
}
console.log('\nCrime type distribution:');
Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

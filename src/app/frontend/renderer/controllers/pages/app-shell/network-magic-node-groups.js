const networkMagicRegionAliases = [
  ['香港', '🇭🇰', /香港|hong[ -]?kong|\b(?:HK|HKG)\b/i],
  ['台湾', '🇹🇼', /台灣|臺灣|台湾|taiwan|\b(?:TW|TPE)\b/i],
  ['日本', '🇯🇵', /日本|东京|東京|大阪|japan|tokyo|osaka|\b(?:JP|NRT|HND)\b/i],
  ['新加坡', '🇸🇬', /新加坡|狮城|獅城|singapore|\b(?:SG|SIN)\b/i],
  ['美国', '🇺🇸', /美国|美國|united states|los angeles|seattle|\b(?:US|USA|LAX)\b/i],
  ['韩国', '🇰🇷', /韩国|韓國|首尔|首爾|korea|seoul|\b(?:KR|ICN)\b/i],
  ['英国', '🇬🇧', /英国|英國|伦敦|倫敦|united kingdom|london|\b(?:UK|GB|LHR)\b/i],
  ['德国', '🇩🇪', /德国|德國|germany|frankfurt|\b(?:DE|FRA)\b/i],
  ['法国', '🇫🇷', /法国|法國|france|paris|\b(?:FR|CDG)\b/i],
  ['加拿大', '🇨🇦', /加拿大|canada|vancouver|toronto|\b(?:CA|YYZ|YVR)\b/i],
  ['澳大利亚', '🇦🇺', /澳洲|澳大利亚|澳大利亞|australia|sydney|\b(?:AU|SYD)\b/i],
];

function addNetworkMagicNodeGroups(grid, buttons) {
  const groups = new Map();
  for (const button of buttons) {
    const name = button.dataset.nodeName || '';
    const match = networkMagicRegionAliases.find(([, flag, alias]) => name.includes(flag) || alias.test(name));
    const region = match?.[0] || '其他节点';
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(button);
  }
  for (const [region, nodes] of groups) {
    const group = document.createElement('section');
    group.className = 'magic-node-group';
    group.setAttribute('aria-label', region);
    const label = document.createElement('span');
    label.className = 'magic-node-group-name';
    label.textContent = region;
    const items = document.createElement('div');
    items.className = 'magic-node-group-items';
    items.append(...nodes);
    group.append(label, items);
    grid.append(group);
  }
}

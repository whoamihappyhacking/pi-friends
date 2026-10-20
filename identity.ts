export const nameSurnames = ['林','陈','周','苏','沈','顾','陆','许','程','孟','叶','江','宋','唐','夏','乔','温','徐','韩','谢'];
export const avatars = ['🙂','😀','😎','🤓','🧐','🤠','😇','🤗','🥳','😌','🤔','😴','😺','🦊','🐼','🐨','🐯','🦁','🐸','🐵','🐰','🐻','🐧','🦉','🐢','🐳','🦄','🐙','🦖','🐲'];

export function allocateIdentity(agents) {
  const present = agents.filter(a => a.status !== 'departed');
  const used = new Set(present.map(a => `${a.avatar}${a.surname}`));
  const faceCounts = new Map(), surnameCounts = new Map();
  for (const a of present) { faceCounts.set(a.avatar,(faceCounts.get(a.avatar)||0)+1); surnameCounts.set(a.surname,(surnameCounts.get(a.surname)||0)+1); }
  let best, score = Infinity;
  for (const avatar of avatars) for (const surname of nameSurnames) {
    if (used.has(avatar + surname)) continue;
    const faces = faceCounts.get(avatar) || 0;
    const surnames = surnameCounts.get(surname) || 0;
    const candidate = faces + surnames;
    if (candidate < score) { score = candidate; best = { avatar, surname }; }
  }
  if (!best) throw new Error('600 个头像与姓氏组合已用完，请先让已结束成员离队');
  return best;
}
export const displayName = a => `${a.avatar || avatars[0]}${a.surname || nameSurnames[0]}`;

/**
 * The junk-site list. Results from these sites are left out of search results.
 *
 * HOW TO EDIT: one site per line, between quotes, with a comma at the end.
 *   'example.com'     leaves out example.com and everything under it (www.example.com, a.example.com).
 *   'example.*'       leaves out example.com, example.ru, example.co.uk and so on.
 *   'example*'        leaves out every site whose name starts with "example".
 * Remove a line to let that site back in.
 *
 * What is on it: copycat sites. They republish questions and answers from Stack
 * Overflow, or pages from GitHub, often machine-translated, and add nothing of
 * their own. The original is always the better result, and search engines list
 * it too. The entries come from public community block lists of such sites.
 *
 * Every search says how many results this list removed.
 */
export const JUNK_SITES: string[] = [
  // Stack Overflow copies
  'stackoom.com',
  'newbedev.com',
  'exchangetuts.com',
  'coder.work',
  'thecodeteacher.com',
  'debugah.com',
  'programmerah.com',
  'syntaxfix.com',
  'stackovergo.com',
  'qastack.*',
  'qa-stack.pl',
  'it-swarm*',
  'icode9.com',
  'ojit.com',
  'answer-id.com',
  'xspdf.com',
  'try2explore.com',
  'code-examples.net',
  'semicolonworld.com',
  'kotaeta.com',
  'de-vraag.com',
  'askcodez.com',
  'codeflow.site',
  'daplus.net',
  'generacodice.com',
  'itranslater.com',
  'javaer101.com',
  'legkovopros.ru',
  'microeducate.tech',
  'quabr.com',
  'solveforum.com',
  'tutorialmore.com',
  'tutorialguruji.com',
  'tutorialink.com',
  'uwenku.com',
  'voidcc.com',
  'w3coded.com',
  'xbuba.com',
  'zditect.com',
  '9to5answer.com',
  'appsloveworld.com',
  'errorsfixing.com',
  'itcodar.com',
  'pretagteam.com',
  'py4u.net',
  'pythonfixing.com',
  'javafixing.com',
  // GitHub copies
  'githubmemory.com',
  'gitmemory.com',
  'gitmemory.cn',
  'giters.com',
  'githubhot.com',
  'issueexplorer.com',
  'bleepcoder.com',
  'fantashit.com',
  'lifesaver.codes',
  'gitanswer.com',
  'coder.social',
  'issuehint.com',
];

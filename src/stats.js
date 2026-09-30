// Stat catalog: which stats each position card shows, per league (from the product spec).
export const STAT_DEFS = {
  pass_yds: { label: 'Passing yards', short: 'Pass Yds' },
  rush_yds: { label: 'Rushing yards', short: 'Rush Yds' },
  completions: { label: 'Completions', short: 'Cmp' },
  pass_att: { label: 'Pass attempts', short: 'Att' },
  pass_td: { label: 'Passing TDs', short: 'Pass TD' },
  rush_td: { label: 'Rushing TDs', short: 'Rush TD' },
  ints: { label: 'Interceptions thrown', short: 'INT' },
  long_cmp: { label: 'Longest completion', short: 'Long Cmp' },
  fumbles: { label: 'Fumbles', short: 'Fum' },
  fumbles_lost: { label: 'Fumbles lost', short: 'Fum Lost' },
  carries: { label: 'Carries', short: 'Car' },
  targets: { label: 'Targets', short: 'Tgt' },
  receptions: { label: 'Receptions', short: 'Rec' },
  rec_yds: { label: 'Receiving yards', short: 'Rec Yds' },
  long_rush: { label: 'Longest rush', short: 'Long Rush' },
  long_rec: { label: 'Longest catch', short: 'Long Rec' },
  rec_td: { label: 'Receiving TDs', short: 'Rec TD' },
  ypc: { label: 'Yards per carry', short: 'YPC', ratio: true },
  ypr: { label: 'Yards per catch', short: 'Y/Rec', ratio: true },
  tds: { label: 'Touchdowns (rush + rec)', short: 'TD' },
  k_pts: { label: 'Kicking points', short: 'K Pts' },
  xp_made: { label: 'Extra points made', short: 'XP' },
  fg_made: { label: 'Field goals made', short: 'FG' },
};

export const STAT_LISTS = {
  nfl: {
    QB: ['pass_yds', 'rush_yds', 'completions', 'pass_att', 'pass_td', 'rush_td', 'ints', 'long_cmp', 'fumbles', 'fumbles_lost'],
    RB: ['rush_yds', 'rec_yds', 'carries', 'targets', 'receptions', 'long_rush', 'rush_td', 'rec_td', 'fumbles_lost', 'ypc', 'ypr'],
    WR: ['rec_yds', 'targets', 'receptions', 'long_rec', 'rec_td', 'ypr'],
    TE: ['rec_yds', 'targets', 'receptions', 'long_rec', 'rec_td', 'ypr'],
    K: ['k_pts', 'xp_made', 'fg_made'],
  },
  cfb: {
    QB: ['pass_yds', 'rush_yds', 'ints'],
    RB: ['rush_yds', 'rec_yds', 'carries', 'tds'],
    WR: ['rec_yds', 'rec_td', 'targets'],
    TE: ['rec_yds', 'rec_td', 'targets'],
  },
};

// Stats the card shows in the collapsed view (graph selector); the rest go in "details".
export const COMPACT = {
  QB: ['pass_yds', 'rush_yds', 'pass_td', 'ints', 'completions', 'pass_att'],
  RB: ['rush_yds', 'rec_yds', 'carries', 'receptions', 'targets', 'tds'],
  WR: ['rec_yds', 'receptions', 'targets', 'rec_td'],
  TE: ['rec_yds', 'receptions', 'targets', 'rec_td'],
  K: ['k_pts', 'fg_made', 'xp_made'],
};

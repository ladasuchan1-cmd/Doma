'use strict';
// Souhrnný export admin stránek (SPEC kap. 13) pro src/features/admin.js.

module.exports = {
  shared: require('./shared'),
  login: require('./login'),
  dnes: require('./dnes'),
  rezervace: require('./rezervace'),
  kalendar: require('./kalendar'),
  kola: require('./kola'),
  cenik: require('./cenik'),
  platby: require('./platby'),
  emaily: require('./emaily'),
  zakaznici: require('./zakaznici'),
  obsah: require('./obsah'),
  nastaveni: require('./nastaveni'),
  audit: require('./audit'),
};

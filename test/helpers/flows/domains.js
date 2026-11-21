'use strict';

// Test capability contracts contain no execution logic or production payload
// schemas. The same contract is used by preflight and by the fixture binding.
const domains = {
  'native-browser': {
    requireOracle: true,
    operations: {
      browser_control: 'action', browser_tab: 'action', browser_wait: 'observation',
      browser_observe: 'observation', browser_action: 'action', browser_workflow: 'action',
      findObserved: 'observation', checkReport: 'observation',
      observationEvidence: 'observation', tabTargets: 'observation',
      inspectState: 'oracle', inspectTabs: 'oracle',
    },
  },
  'remote-peer': {
    requireOracle: true,
    operations: { start: 'action', frame: 'action', waitEvent: 'oracle' },
  },
  'account-preferences': {
    requireOracle: true,
    operations: { openPersonal: 'action', click: 'action', reload: 'action', inspect: 'oracle', inspectSaved: 'oracle' },
  },
  'home-workspace': {
    requireOracle: true,
    operations: { click: 'action', key: 'action', filterSites: 'action', inspect: 'oracle',
      inspectBackground: 'oracle', inspectAccountRequests: 'oracle' },
  },
  'electron-pages': {
    requireOracle: true,
    operations: { open: 'action', load: 'action', inspect: 'oracle', close: 'action', inspectWindow: 'oracle' },
  },
};
for (const contract of Object.values(domains)) {
  Object.freeze(contract.operations);
  Object.freeze(contract);
}
Object.freeze(domains);

function domainContract(name) {
  if (!Object.hasOwn(domains, name)) throw new Error('UNKNOWN_VERIFICATION_DOMAIN');
  return Object.freeze({ id: name, ...domains[name] });
}

function bindDomain(name, drivers) {
  const contract = domainContract(name);
  const expected = Object.keys(contract.operations).sort();
  const actual = Object.keys(drivers).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)
    || actual.some((key) => typeof drivers[key] !== 'function')) throw new Error('DOMAIN_DRIVER_MISMATCH');
  return { contract, drivers: Object.freeze({ ...drivers }) };
}

module.exports = { domainContract, bindDomain };

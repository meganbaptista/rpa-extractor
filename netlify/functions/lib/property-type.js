/**
 * Property-type signals derived from what the pipeline actually has on hand.
 *
 * WHY THIS EXISTS: the SPQ brush/vegetation clearance item (17F on the 12/24
 * SPQ, 17G on 6/26) was being asserted as "should be Yes" for ANY property in a
 * high or very high fire hazard severity zone. That is wrong for a condominium:
 * the unit owner owns no ground, and vegetation management on the common area
 * belongs to the association, so a "No" there is the CORRECT answer even deep
 * inside a fire zone. Confirmed on 1345 N Hayworth Ave #5, West Hollywood.
 *
 * WHY NOT THE HOA FLAG: fetchDealContext already reads `hasHoa` from the master
 * sheet, and keying off that would be easier. It would also be wrong in the
 * dangerous direction. A detached single-family home in an HOA still owns its
 * own lot and still owes brush clearance, and hillside HOA tracts are exactly
 * the wildfire-exposed properties this check exists to protect. `hasHoa` would
 * silence the check on the homes that need it most.
 *
 * WHY THE ADDRESS: inside these functions the deal context carries yearBuilt,
 * hasHoa and highFireHazard, but no property type. A unit designator in the
 * address is the only condo signal available here, and it is a good one: an
 * address needs a unit number precisely when the dwelling is stacked or
 * attached. Where a real property type IS available (the compliance-list
 * generator has `propertyType`), prefer it and pass it in.
 */

// A unit designator: "#5", "# 5", "Unit 5", "Apt 4B", "Ste 200".
//
// The keyword alternatives are \b-anchored on BOTH sides so a street name can
// never trip them: "Unity Ave" must not read as "Unit y". The leading
// (?:^|[\s,]) stops a bare "#" inside some other token from matching.
const UNIT_DESIGNATOR =
  /(?:^|[\s,])(?:#\s*[A-Za-z0-9][\w-]*|\b(?:unit|apt|apartment|ste|suite)\b\.?\s+[A-Za-z0-9][\w-]*)/i;

/** True when the address carries a unit designator (stacked/attached dwelling). */
function hasUnitDesignator(address) {
  return UNIT_DESIGNATOR.test(String(address == null ? '' : address));
}

// Property-type strings that mean the owner holds no ground of their own.
//
// Townhouses and PUDs are deliberately EXCLUDED. Both commonly come with a
// private yard or a maintenance obligation that runs to the lot line, so
// clearing brush can genuinely be the owner's. Suppressing the check for them
// would under-disclose a real fire obligation, which is the failure that
// actually costs someone. Over-asking a condo seller is a nuisance;
// under-asking a townhouse seller in a fire zone is a liability.
const GROUNDLESS_TYPE = /\b(?:condo(?:minium)?s?|co-?op(?:erative)?|apartment|stock\s*co-?op)\b/i;

/** True when an explicit property type means the owner maintains no grounds. */
function isGroundlessType(propertyType) {
  return GROUNDLESS_TYPE.test(String(propertyType == null ? '' : propertyType));
}

// Types where the owner DOES hold ground and therefore can owe clearance.
const GROUND_OWNING_TYPE =
  /\b(?:sfr|sfd|single[-\s]*family|detached|townhouses?|town\s?homes?|pud|planned\s*unit)\b/i;

/**
 * True when a property type names a groundless type AND a ground-owning one in
 * the same string, so it says nothing about THIS property.
 *
 * This is not hypothetical. Process Street's "Type Of Property" field bridges
 * the two into a single option literally reading "Standard Condo/SFR". Trusting
 * it would exempt every single-family home that uses that option, silencing the
 * brush check on the properties that most need it. An ambiguous type is worse
 * than no type, so it is treated as unknown.
 *
 * Megan is keeping the bridged field in Process Street and splitting condo from
 * SFR in Keeva instead, so this guard stays until Keeva feeds the type through.
 */
function isTypeAmbiguous(propertyType) {
  const s = String(propertyType == null ? '' : propertyType);
  return GROUNDLESS_TYPE.test(s) && GROUND_OWNING_TYPE.test(s);
}

/**
 * Should the SPQ brush/vegetation clearance item be exempted from the
 * "high fire zone means this must be Yes" rule?
 *
 * A property type is used ONLY when it is unambiguous. Anything bridged, and
 * anything blank, falls through to the address unit designator, which is the
 * signal that actually distinguishes a condo unit from a house today.
 */
function isBrushClearanceExempt({ propertyType, address } = {}) {
  const t = String(propertyType == null ? '' : propertyType).trim();
  if (t && !isTypeAmbiguous(t)) return isGroundlessType(t);
  return hasUnitDesignator(address);
}

module.exports = {
  UNIT_DESIGNATOR,
  GROUNDLESS_TYPE,
  GROUND_OWNING_TYPE,
  hasUnitDesignator,
  isGroundlessType,
  isTypeAmbiguous,
  isBrushClearanceExempt,
};

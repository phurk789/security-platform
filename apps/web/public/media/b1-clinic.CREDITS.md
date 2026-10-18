# b1-clinic.glb — source and licence

Stand-in BIM model for Building 1 in the demo (it is not the real building on the site).

- Source: BSI (2020) "Medical-Dental Test Files," buildingSMART International —
  https://github.com/buildingsmart-community/Community-Sample-Test-Files
  (`IFC 2.3.0.1 (IFC 2x3)/Medical-Dental Clinic/Clinic_Architectural.ifc`)
- Licence: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- Changes: converted from IFC to glTF with IfcOpenShell (world coordinates, Z-up → Y-up, north = −Z),
  spaces, openings, furniture and sanitary fittings left out, geometry grouped by material colour,
  centred on its footprint with the ground at y = 0.

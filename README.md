# Envelope Studio

Evidence-gated decision support for choosing external wall materials in warm-humid Kerala, India.
It is a research demonstrator from a B.Arch dissertation (Bishop Jerome School of Architecture, Kollam).

**Live site:** https://creez-studio.github.io/envelope-studio/

Using the site:
* Set up the project (location, building type), then load an IFC model or enter facade areas.
* Choose goals and a masonry budget.
* Compare 13 wall options on U-value (ENS 2024), embodied carbon, unit cost, ENS RETV, daily heat damping (EN ISO 13786) and climate exposure.
* Values without a cited source are never used. Every score is partial and labelled as such.

How it runs:
* This repository holds the static website only. It runs entirely in the browser, and an uploaded IFC file never leaves your computer.
* The 3D viewer loads three.js and web-ifc from jsDelivr.
* The optional local backend (IfcOpenShell and an Ollama model) is not part of this hosted version. The site shows "Browser only" when the backend isn't present.

The site gives decision support only. It does not determine code compliance, structural adequacy, fire performance or moisture behaviour.

## Sample model credit
`data/models/duplex.ifc` is the Duplex Apartment architectural model: BSI (2020) "Duplex Apartment Test Files," buildingSMART International,
https://github.com/buildingsmart-community/Community-Sample-Test-Files, licensed CC BY 4.0. It is used unchanged; the site only relocates it to the chosen site for analysis.

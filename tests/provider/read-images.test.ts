import test from "node:test";
import assert from "node:assert/strict";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

test("CodingTools with createNodePhotonImages registers read tool capable of image processing", async () => {
	const images = await createNodePhotonImages();
	const tools = createCodingTools({ images });
	const readTool = tools.tools?.find((t) => t.name === "read");
	assert.ok(readTool, "Read tool must be registered");
	assert.equal(readTool.name, "read");
});

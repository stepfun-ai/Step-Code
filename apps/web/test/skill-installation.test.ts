import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSkillInstallation } from "../src/skill-installation.ts";

test("SkillHub receipt requires matching content, identity, canonical URL and bounded regular files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stepcode-skill-receipt-"));
	const file = join(dir, "SKILL.md");
	const receipt = join(dir, "stepcode.skill-install.json");
	const body = "---\nname: ppt-generator\n---\n# Test\n";
	const data = {schemaVersion:1,source:"skillhub",registryId:"@user_3b34947d/ppt-generator-skill",sourceUrl:"https://skillhub.cn/skills/user_3b34947d/ppt-generator-skill",version:"1.0.2",skillName:"ppt-generator",skillSha256:createHash("sha256").update(body).digest("hex")};
	try {
		await writeFile(file, body);
		assert.equal(await readSkillInstallation(file,"ppt-generator"),undefined);
		await writeFile(receipt,JSON.stringify(data));
		assert.equal((await readSkillInstallation(file,"ppt-generator"))?.registryId,data.registryId);
		assert.equal(await readSkillInstallation(file,"impostor"),undefined);
		await writeFile(file,`${body}Changed`);
		assert.equal(await readSkillInstallation(file,"ppt-generator"),undefined);
		await writeFile(file,body);
		for (const patch of [{sourceUrl:"https://example.com/skills/user_3b34947d/ppt-generator-skill"},{sourceUrl:`${data.sourceUrl}?token=not-a-real-token`},{registryId:"@another/skill"},{schemaVersion:99}]) {
			await writeFile(receipt,JSON.stringify({...data,...patch}));
			assert.equal(await readSkillInstallation(file,"ppt-generator"),undefined);
		}
		await writeFile(receipt," ".repeat(8193));
		assert.equal(await readSkillInstallation(file,"ppt-generator"),undefined);
		await rm(receipt);await symlink(file,receipt);
		assert.equal(await readSkillInstallation(file,"ppt-generator"),undefined);
	} finally { await rm(dir,{recursive:true,force:true}); }
});

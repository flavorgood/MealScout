import { backfillExistingProfileSalesAssistants } from "../server/services/profileSalesAssistantStore";

const result = await backfillExistingProfileSalesAssistants();
console.log(JSON.stringify(result));

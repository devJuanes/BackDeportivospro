const express = require("express");
const { postGeneratePrevias, postGenerateRecaps } = require("../controllers/blogController");

const router = express.Router();

router.post("/generate-previas", postGeneratePrevias);
router.post("/generate-recaps", postGenerateRecaps);

module.exports = router;

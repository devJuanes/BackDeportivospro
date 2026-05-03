const express = require("express");
const {
  postGeneratePrevias,
  postGeneratePreviaForPick,
  postGenerateRecaps,
} = require("../controllers/blogController");

const router = express.Router();

router.post("/generate-previas", postGeneratePrevias);
router.post("/generate-previa-for-pick", postGeneratePreviaForPick);
router.post("/generate-recaps", postGenerateRecaps);

module.exports = router;

const express = require("express");
const ctrl = require("../controllers/adminController");

const router = express.Router();

router.get("/me", ctrl.me);
router.get("/vip-requests", ctrl.listVipRequests);
router.post("/vip-requests/:id/decide", ctrl.decideVipRequest);
router.get("/users", ctrl.listUsers);
router.patch("/users/:id", ctrl.patchUser);
router.post("/tips/settle", ctrl.settleTip);
router.post("/tips", ctrl.createTip);
router.patch("/tips/:tier/:id", ctrl.updateTip);
router.get("/factory/status", ctrl.factoryStatus);
router.post("/factory/power", ctrl.factoryPower);
router.post("/factory/settle-power", ctrl.settlePower);
router.post("/factory/run-now", ctrl.factoryRun);
router.get("/modals/active", ctrl.activeModalPublic);
router.get("/modals", ctrl.listModals);
router.post("/modals", ctrl.upsertModal);
router.delete("/modals/:id", ctrl.deleteModal);
router.post("/news", ctrl.createNews);
router.get("/futbool/status", ctrl.futboolStatus);
router.post("/futbool/reload", ctrl.futboolReload);

module.exports = router;

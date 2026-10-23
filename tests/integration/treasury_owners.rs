//! Dashboard-owned process test, using the pinned runtime's unmodified native fixture.
use std::{path::PathBuf, time::Duration};

use eez_testkit::{
    ANVIL_ATTESTER_KEY, DEV_CHAIN_ID, assert_latest_batch_signature, native,
    setup_cross_chain_with_env, signer_address, wait_for_safe_prefix_convergence,
};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn treasury_owner_quorum_settles_and_replays() {
    let root = PathBuf::from(std::env::var_os("TREASURY_DASHBOARD_ROOT").expect("dashboard root"));
    let evidence_dir =
        PathBuf::from(std::env::var_os("TREASURY_EVIDENCE_DIR").expect("evidence dir"));
    let trace_directory = evidence_dir.join("composition-traces");
    let world = setup_cross_chain_with_env(&[
        ("EEZ_SETTLEMENT_PURE_L2_MODE", "always".to_owned()),
        ("EEZ_TEST_L2_DEBUG_RPC", "true".to_owned()),
        // The native relay forwards into a fee-ordered mempool, not an atomic
        // builder. Keep postBatch ahead of the fixture wallet's 1 gwei tip even
        // after an idle budget epoch. This is not a production ordering guarantee.
        ("EEZ_L1_POSTBATCH_MIN_PRIORITY_FEE", "2000000000".to_owned()),
        (
            "EEZ_COMPOSER_GAS_TRACE_ADDRESS",
            "0x976EA74026E726554dB657fA54763abd0C3a0aa9".to_owned(),
        ),
        (
            "EEZ_COMPOSER_GAS_TRACE_DIR",
            trace_directory.display().to_string(),
        ),
    ])
    .await
    .expect("fresh isolated native devnet");
    let follower = native::spawn_follower(&world, "treasury-follower")
        .await
        .expect("independent follower");
    let network_file = evidence_dir.join("network.json");
    std::fs::write(
        &network_file,
        serde_json::to_vec_pretty(&json!({
            "fixture": "eez-testkit native process devnet",
            "l1": {"rpc": world.l1_rpc(), "front": world.l1_xchain(), "chainId": DEV_CHAIN_ID},
            "l2": {"rpc": world.l2_rpc(), "front": world.l2_xchain(), "chainId": world.l2_chain_id},
            "follower": follower.l2_rpc_url(),
            "traceDirectory": trace_directory,
            "registry": format!("{:#x}", world.cfg.eez_address),
            "rollupId": world.cfg.rollup_id,
            "deployBlock": world.dep.deploy_block,
            "attester": format!("{:#x}", signer_address(ANVIL_ATTESTER_KEY).unwrap()),
        }))
        .unwrap(),
    )
    .unwrap();
    println!("Fresh devnet ready; running the dashboard Safe-signing scenario");
    let status = tokio::process::Command::new("node")
        .arg(root.join("tests/integration/treasury-owners.mjs"))
        .arg(&network_file)
        .arg(evidence_dir.join("scenario.json"))
        .current_dir(&root)
        .kill_on_drop(true)
        .status()
        .await
        .expect("run Node scenario");
    assert!(
        status.success(),
        "Safe scenario failed: {status}{}",
        world.settlement_diagnostics()
    );
    let mut evidence: serde_json::Value =
        serde_json::from_slice(&std::fs::read(evidence_dir.join("scenario.json")).unwrap())
            .unwrap();
    let through = evidence["lastSuccessfulL2Block"]
        .as_u64()
        .expect("successful L2 height");
    let converged = wait_for_safe_prefix_convergence(
        &[&world.node, &follower],
        through,
        Duration::from_secs(120),
    )
    .await
    .expect("Composer and independent follower agree beyond the Safe action");
    assert_latest_batch_signature(
        &world.l1_rpc(),
        &world.dep,
        signer_address(ANVIL_ATTESTER_KEY).unwrap(),
    )
    .await
    .expect("posted proof recovers against independently recomputed public inputs");
    world.proof_signer.assert_alive();
    world.node.assert_no_divergence_failure_logs();
    follower.assert_no_divergence_failure_logs();
    evidence["independentReplay"] =
        json!({"height": converged.number, "hash": format!("{:#x}", converged.hash)});
    evidence["postedAttestationVerified"] = json!(true);
    evidence["verified"] = json!(true);
    std::fs::write(
        evidence_dir.join("scenario.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
}

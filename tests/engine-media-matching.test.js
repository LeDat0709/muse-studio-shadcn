"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isForeignFinalVideo } = require("../src/engine");

test("a final_<tag> video from a different job is rejected", () => {
  // Our job's tag is "aaaaaa"; a sibling job produced final_bbbbbb_20s.mp4.
  assert.equal(isForeignFinalVideo("workspace/imagine_media/final_bbbbbb_20s.mp4", "aaaaaa"), true);
  assert.equal(isForeignFinalVideo("https://cdn/x/FINAL_BBBBBB_8s.MP4", "aaaaaa"), true);
});

test("our own final_<tag> video is not foreign", () => {
  assert.equal(isForeignFinalVideo("workspace/imagine_media/final_aaaaaa_20s.mp4", "aaaaaa"), false);
  assert.equal(isForeignFinalVideo("final_AAAAAA_6s.mp4", "aaaaaa"), false);
});

test("an untagged / non-final path is not treated as foreign", () => {
  // No final_<tag> pattern -> can't attribute to another job, so don't reject here.
  assert.equal(isForeignFinalVideo("workspace/imagine_media/video_123.mp4", "aaaaaa"), false);
  assert.equal(isForeignFinalVideo("https://cdn/media/abc123", "aaaaaa"), false);
  assert.equal(isForeignFinalVideo("", "aaaaaa"), false);
});

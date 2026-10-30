def test_node_pack_exports_mappings():
    import motionfield_nodes

    assert isinstance(motionfield_nodes.NODE_CLASS_MAPPINGS, dict)
    assert isinstance(motionfield_nodes.NODE_DISPLAY_NAME_MAPPINGS, dict)
